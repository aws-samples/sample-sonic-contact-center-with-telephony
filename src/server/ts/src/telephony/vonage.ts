import { Request, Response } from "express";
import { Session } from "../types";
import { Buffer } from "node:buffer";

export interface WebhookResponse {
  action: string;
  text?: string;
  from?: string;
  endpoint?: {
    type: string;
    uri: string;
    "content-type": string;
  }[];
}

export class VonageIntegration {
  isOn: boolean;

  constructor(isOn: boolean = false) {
    this.isOn = isOn;
    if (this.isOn) console.log("Vonage integration initialized.");
  }

  public configureRoutes(app: any): void {
    if (!this.isOn) return;

    app.get("/webhooks/answer", this.handleWebhookAnswer.bind(this));
    app.post("/webhooks/events", this.handleWebhookEvents.bind(this));
  }

  private handleWebhookAnswer(req: Request, res: Response): void {
    const nccoResponse: WebhookResponse[] = [
      {
        action: "talk",
        text: "Hello, welcome to our automated assistant. How can I help you today?",
      },
      {
        action: "connect",
        from: "Vonage",
        endpoint: [
          {
            type: "websocket",
            uri: `wss://${req.hostname}/socket`,
            "content-type": "audio/l16;rate=16000",
          },
        ],
      },
    ];
    
    res.status(200).json(nccoResponse);
  }

  private handleWebhookEvents(req: Request, res: Response): void {
    console.log("Vonage event received:", req.body);
    res.sendStatus(200);
  }

  public async processAudioData(message: Buffer, session: Session): Promise<void> {
    if (!this.isOn) return;
    
    try {
      const audioBuffer = Buffer.from(message);
      await session.streamAudio(audioBuffer);
    } catch (error) {
      console.error("Error processing Vonage audio data:", error);
    }
  }
}