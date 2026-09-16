// PM2 process config — run with: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'deepdark',
      script: 'server.js',
      cwd: '/var/www/deepdark/videocall',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // DB_PATH: '/var/www/deepdark/videocall/videocall.db',  // default location
      },
      instances: 1,       // Socket.IO requires sticky sessions if > 1
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/var/log/deepdark/out.log',
      error_file: '/var/log/deepdark/error.log',
    },
  ],
};
