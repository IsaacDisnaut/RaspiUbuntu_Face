#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <ArduinoJson.h>

#define SDA_PIN 21
#define SCL_PIN 22

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

// ================= Servo Pulse =================

const uint16_t servoMin[] = {
    130, // CH0 MG996R (Head)
    130, // CH1 MG996R (Mouth)
    150, // CH2 1109MG (Eye X)
    150  // CH3 1109MG (Eye Y)
};

const uint16_t servoMax[] = {
    620, // CH0 MG996R
    620, // CH1 MG996R
    600, // CH2 1109MG
    600  // CH3 1109MG
};

// ================= Initial Position =================

float currentAngle[4] = {
    45.0, // Head
    30.0, // Mouth
    90.0, // Eye X center
    90.0  // Eye Y center
};

float targetAngle[4] = {
    45.0,
    30.0,
    90.0,
    90.0
};

// ================= Motion =================

const float STEP_SIZE = 1.0f;

enum MotionState
{
    IDLE,
    MOVING
};

MotionState state = IDLE;

// ===================================================

void setServoAngle(uint8_t ch, float angle)
{
    uint16_t pulse = map(
        (int)angle,
        0,
        180,
        servoMin[ch],
        servoMax[ch]);

    pwm.setPWM(ch, 0, pulse);
}

// ===================================================

void updateServos()
{
    bool allReached = true;

    for (int i = 0; i < 4; i++)
    {
        if (currentAngle[i] < targetAngle[i])
        {
            currentAngle[i] += STEP_SIZE;

            if (currentAngle[i] > targetAngle[i])
                currentAngle[i] = targetAngle[i];
        }
        else if (currentAngle[i] > targetAngle[i])
        {
            currentAngle[i] -= STEP_SIZE;

            if (currentAngle[i] < targetAngle[i])
                currentAngle[i] = targetAngle[i];
        }

        if (abs(currentAngle[i] - targetAngle[i]) > 0.01f)
        {
            allReached = false;
        }

        setServoAngle(i, currentAngle[i]);
    }

    if (allReached && state == MOVING)
    {
        Serial.println("RUN COMPLETE");
        state = IDLE;
    }
}

// ===================================================

void setup()
{
    Serial.begin(115200);

    delay(500);

    Wire.begin(SDA_PIN, SCL_PIN);

    pwm.begin();
    pwm.setOscillatorFrequency(27000000);
    pwm.setPWMFreq(50);

    for (int i = 0; i < 4; i++)
    {
        setServoAngle(i, currentAngle[i]);
    }

    Serial.println("STATUS: IDLE");
    Serial.println("=== ESP32 PCA9685 Ready ===");
}

// ===================================================

void loop()
{
    if (Serial.available())
    {
        String input = Serial.readStringUntil('\n');
        input.trim();

        int firstBrace = input.indexOf('{');
        int lastBrace = input.lastIndexOf('}');

        if (firstBrace != -1 &&
            lastBrace != -1 &&
            firstBrace < lastBrace)
        {
            String cleanJson =
                input.substring(firstBrace, lastBrace + 1);

            StaticJsonDocument<256> doc;

            DeserializationError error =
                deserializeJson(doc, cleanJson);

            if (!error)
            {
                int headAngle =
                    doc["Head"] | 45;

                int mouthAngle =
                    doc["Mouth"] | 30;

                float analogX =
                    doc["Analog"]["x"] | 0.0f;

                float analogY =
                    doc["Analog"]["y"] | 0.0f;

                analogX =
                    constrain(analogX, -1.0f, 1.0f);

                analogY =
                    constrain(analogY, -1.0f, 1.0f);

                // X ปกติ
                int servoX =
                    (analogX + 1.0f) * 90.0f;

                // Y กลับทิศ
                int servoY =
                    (1.0f - analogY) * 90.0f;

                targetAngle[0] =
                    constrain(headAngle, 0, 180);

                targetAngle[1] =
                    constrain(mouthAngle, 30, 90);

                targetAngle[2] =
                    constrain(servoX, 10, 170);

                targetAngle[3] =
                    constrain(servoY, 10, 170);

                if (state == IDLE)
                {
                    Serial.println("STATUS: MOVING");
                }

                state = MOVING;
            }
            else
            {
                Serial.print("STATUS: JSON_ERROR -> ");
                Serial.println(error.c_str());
            }
        }
    }

    updateServos();

    delay(10);
}