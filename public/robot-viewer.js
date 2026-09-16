'use strict';
// Three.js URDF viewer for the InMoov head (inmoov_urdf-master archive).
// Requires three.min.js + STLLoader.js + OrbitControls.js loaded first.
(function () {

  // Blender-unit → metres scale factor (from properties.xacro model_scale)
  var MODEL_SCALE = 0.1196;

  // Material palette keyed on link-name substrings
  var MAT = {
    eye:    { color: 0x888888, specular: 0xaaaaaa, shininess: 90 },
    neck:   { color: 0x777777, specular: 0x555555, shininess: 35 },
    jaw:    { color: 0x808080, specular: 0x555555, shininess: 30 },
    rothead:{ color: 0x909090, specular: 0x666666, shininess: 28 },
    default:{ color: 0x858585, specular: 0x555555, shininess: 30 },
  };

  function materialFor(linkName) {
    var T = window.THREE;
    var c;
    if (linkName.indexOf('eye') !== -1 && linkName.indexOf('.001') === -1) c = MAT.eye;
    else if (linkName === 'neck_link')                     c = MAT.neck;
    else if (linkName.indexOf('jaw')     !== -1)           c = MAT.jaw;
    else if (linkName.indexOf('rothead') !== -1)           c = MAT.rothead;
    else c = MAT.default;
    return new T.MeshPhongMaterial({ color: c.color, specular: c.specular, shininess: c.shininess });
  }

  function parseVec3(str) {
    return (str || '0 0 0').trim().split(/\s+/).map(Number);
  }

  function loadSTL(url, material) {
    return new Promise(function (resolve) {
      new window.THREE.STLLoader().load(url, function (geo) {
        geo.computeVertexNormals();
        resolve(new window.THREE.Mesh(geo, material));
      }, undefined, function (err) {
        console.warn('[RobotViewer] 404:', url);
        resolve(null);
      });
    });
  }

  // ── Constructor ────────────────────────────────────
  function RobotViewer(canvas) {
    this._canvas   = canvas;
    this._renderer = null;
    this._scene    = null;
    this._camera   = null;
    this._controls = null;
    this._joints   = {};
    this._raf      = null;
  }

  // ── init ───────────────────────────────────────────
  RobotViewer.prototype.init = function () {
    var self   = this;
    var THREE  = window.THREE;
    var canvas = this._canvas;

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    this._renderer = renderer;

    var scene = new THREE.Scene();
    this._scene = scene;

    var camera = new THREE.PerspectiveCamera(38, 1, 0.001, 10);
    this._camera = camera;

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    var d1 = new THREE.DirectionalLight(0xffffff, 0.85);
    d1.position.set(2, 3, 4);
    scene.add(d1);
    var d2 = new THREE.DirectionalLight(0x99aaff, 0.3);
    d2.position.set(-2, -1, -1);
    scene.add(d2);

    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minDistance   = 0.05;
    controls.maxDistance   = 2.0;
    this._controls = controls;

    function resize() {
      var parent = canvas.parentElement;
      if (!parent) return;
      var w = parent.clientWidth, h = parent.clientHeight;
      if (w < 1 || h < 1) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    resize();
    new ResizeObserver(resize).observe(canvas.parentElement);

    return this._loadURDF('/robot/head.urdf').then(function () {
      // Camera looks at head centre from the front (+X direction)
      camera.position.set(0.45, 0.05, 0.05);
      controls.target.set(0, 0.04, 0);
      controls.update();
      self._loop();
      return self;
    });
  };

  // ── URDF loader ────────────────────────────────────
  RobotViewer.prototype._loadURDF = function (url) {
    var self  = this;
    var THREE = window.THREE;

    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      var doc   = new DOMParser().parseFromString(text, 'text/xml');
      var links = {};
      var loads = [];

      // ── 1. Create a Group per link; queue one STL load per <visual> ──
      var linkEls = doc.querySelectorAll('link');
      for (var i = 0; i < linkEls.length; i++) {
        (function (linkEl) {
          var name  = linkEl.getAttribute('name');
          var group = new THREE.Group();
          group.name = 'link:' + name;
          links[name] = group;

          var visuals = linkEl.querySelectorAll('visual');
          for (var v = 0; v < visuals.length; v++) {
            (function (visual) {
              var meshEl = visual.querySelector('geometry mesh');
              if (!meshEl) return;

              var filename = meshEl.getAttribute('filename');
              var scaleArr = parseVec3(meshEl.getAttribute('scale') || '1 1 1');
              var mat      = materialFor(name);
              var originEl = visual.querySelector('origin');
              var xyz      = parseVec3(originEl ? originEl.getAttribute('xyz') : null);
              var rpy      = parseVec3(originEl ? originEl.getAttribute('rpy') : null);

              loads.push(loadSTL(filename, mat).then(function (mesh) {
                if (!mesh) return;
                mesh.scale.set(scaleArr[0], scaleArr[1], scaleArr[2]);
                mesh.position.set(xyz[0], xyz[1], xyz[2]);
                mesh.rotation.set(rpy[0], rpy[1], rpy[2]);
                group.add(mesh);
              }));
            })(visuals[v]);
          }
        })(linkEls[i]);
      }

      return Promise.all(loads).then(function () {
        var joints    = {};
        var childSet  = {};
        var jointEls  = doc.querySelectorAll('joint');

        // ── 2. Wire joint hierarchy ──
        for (var j = 0; j < jointEls.length; j++) {
          var jEl        = jointEls[j];
          var jname      = jEl.getAttribute('name');
          var jtype      = jEl.getAttribute('type');
          var parentName = jEl.querySelector('parent').getAttribute('link');
          var childName  = jEl.querySelector('child').getAttribute('link');

          var orig   = jEl.querySelector('origin');
          var jxyz   = parseVec3(orig ? orig.getAttribute('xyz') : null);
          var jrpy   = parseVec3(orig ? orig.getAttribute('rpy') : null);

          var axEl   = jEl.querySelector('axis');
          var axArr  = parseVec3(axEl ? axEl.getAttribute('xyz') : '0 0 1');
          var axVec  = new THREE.Vector3(axArr[0], axArr[1], axArr[2]).normalize();

          var limEl  = jEl.querySelector('limit');
          var lower  = limEl ? parseFloat(limEl.getAttribute('lower') || '-3.14') : -3.14;
          var upper  = limEl ? parseFloat(limEl.getAttribute('upper') ||  '3.14') :  3.14;

          // origin group: fixed position/rotation offset from parent
          var og = new THREE.Group();
          og.name = 'jOrig:' + jname;
          og.position.set(jxyz[0], jxyz[1], jxyz[2]);
          og.rotation.set(jrpy[0], jrpy[1], jrpy[2]);

          // pivot group: spins for the joint angle
          var pg = new THREE.Group();
          pg.name = 'jPivot:' + jname;
          og.add(pg);

          var childLink = links[childName];
          if (childLink) pg.add(childLink);

          var parentLink = links[parentName];
          if (parentLink) parentLink.add(og);

          childSet[childName] = true;

          if (jtype !== 'fixed') {
            joints[jname] = { pivot: pg, axis: axVec, lower: lower, upper: upper };
          }
        }

        // ── 3. Attach root link to scene ──
        var root = new THREE.Group();
        // Convert URDF Z-up to Three.js Y-up, then apply model scale
        root.rotation.x = -Math.PI / 2;
        root.scale.setScalar(MODEL_SCALE);

        var names = Object.keys(links);
        for (var k = 0; k < names.length; k++) {
          if (!childSet[names[k]]) {
            root.add(links[names[k]]);
            break;
          }
        }
        self._scene.add(root);
        self._joints = joints;
      });
    }).catch(function (e) {
      console.error('[RobotViewer] URDF load failed:', e);
    });
  };

  // ── Public API ─────────────────────────────────────
  RobotViewer.prototype.setJoint = function (name, angle) {
    var j = this._joints[name];
    if (!j) return;
    j.pivot.quaternion.setFromAxisAngle(j.axis, Math.max(j.lower, Math.min(j.upper, angle)));
  };

  RobotViewer.prototype._loop = function () {
    var self = this;
    this._raf = requestAnimationFrame(function () { self._loop(); });
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  };

  RobotViewer.prototype.dispose = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._renderer) this._renderer.dispose();
  };

  window.RobotViewer = RobotViewer;
})();
