import { Request, Response } from "express";
import { Conversation } from "../client";
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

  constructor(isOn: boolean = false, app: any) {
    if (!isOn) return;

    this.isOn = isOn;
    this.configureRoutes(app)

    console.log("Vonage integration initialized.");
  }

  public configureRoutes(app: any): void {
    if (!this.isOn) return;

    app.get("/vonage/answer", this.handleWebhookAnswer.bind(this));
    app.post("/vonage/events", this.handleWebhookEvents.bind(this));
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

  public async tryProcessAudioInput(message: Buffer, conversation: Conversation): Promise<void> {
    if (!this.isOn) return;

    try {
      const audioBuffer = Buffer.from(message); // TODO: Needed?
      await conversation.streamAudio(audioBuffer);
    } catch (error) {
      console.error("Error processing Vonage audio data:", error);
    }
  }
}
