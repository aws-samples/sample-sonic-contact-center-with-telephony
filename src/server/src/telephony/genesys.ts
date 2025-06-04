import WebSocket from "ws";
import { Buffer } from "node:buffer";
import { Request, Response } from "express";
import { mulaw } from "alawmulaw";
import { Session } from "../types";

export class GenesysIntegration {
  isOn: boolean;

  constructor(isOn: boolean = false, app: any) {
    if (!isOn) return;

    this.isOn = isOn;
    this.configureRoutes(app);

    console.log("Genesys integration initialized");
  }

  public configureRoutes(app: any): void {
    if (!this.isOn) return;

    app.get("/genesys/audiohook", this.handleAudioHookConfig.bind(this));
    app.post("/genesys/failover", this.handleFailover.bind(this));
  }

  private handleAudioHookConfig(req: Request, res: Response): void {
    console.log("Genesys AudioHook configuration request");
    const wsHost = req.headers.host || "localhost";
    const wsUrl = `wss://${wsHost}/socket`;
    res.json({
      status: "success",
      websocketUrl: wsUrl,
      message: "WebSocket endpoint for Genesys AudioHook"
    });
  }

  private handleFailover(req: Request, res: Response): void {
    console.log("Genesys failover triggered");
    const failoverResponse = {
      status: "failover",
      message: "Redirecting call to a human agent"
    };
    res.json(failoverResponse);
  }

  private messageHandlers = new Map<
    string,
    (jsonMsg: any, session: Session) => Promise<void>
  >([
    [
      "connect",
      async (jsonMsg, session) => {
        session.streamId = jsonMsg.streamId || jsonMsg.callId;
        console.log(`Started Genesys AudioHook with streamSid ${session.streamId}`);
      }
    ],
    [
      "audio",
      async (jsonMsg, session) => {
        if (jsonMsg.audio && jsonMsg.audio.payload) {
          const audioInput = Buffer.from(jsonMsg.audio.payload, "base64");
          const pcmSamples = mulaw.decode(audioInput);
          const audioBuffer = Buffer.from(pcmSamples.buffer);
          await session.streamAudio(audioBuffer);
        } else {
          console.error("Invalid audio payload:", jsonMsg);
        }
      }
    ],
    [
      "error",
      async (jsonMsg, session) => {
        console.error("Genesys AudioHook error:", jsonMsg.error || "Unknown error");
      }
    ]
  ]);

  public async tryProcessAudioInput(
    msg: string,
    session: Session
  ): Promise<void> {
    if (!this.isOn) return;

    try {
      const data = JSON.parse(msg.toString());
      const eventType = data.event || data.type;
      const handler = this.messageHandlers.get(eventType);

      if (handler) {
        await handler(data, session);
      } else {
        console.error("Caught unclassified Genesys message:", data);
      }
    } catch (error) {
      console.error("Error processing Genesys audio data:", error);
    }
  }

  public async tryProcessAudioOutput(
    pcmSamples: Int16Array,
    clients: any,
    streamId: string
  ): Promise<void> {
    if (!this.isOn) return;

    try {
      const resampledPcmSamples = this.resample16kHzTo8kHz(pcmSamples);
      const mulawSamples = mulaw.encode(resampledPcmSamples);
      const payload = Buffer.from(mulawSamples).toString("base64");
      const response = JSON.stringify({
        event: "audio",
        audio: {
          track: "outbound",
          payload
        },
        streamId
      });
      console.log("Genesys response:", response);

      clients?.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(response);
      });
    } catch (e) {
      console.error("An error occurred processing Genesys audio output:", e);
    }
  }

  private resample16kHzTo8kHz(pcmSamples: Int16Array): Int16Array {
    const outputLength = Math.ceil(pcmSamples.length / 2);
    const result = new Int16Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      result[i] = pcmSamples[i * 2]; // Take every other sample
    }
    return result;
  }
}