import WebSocket from "ws";
import { Buffer } from "node:buffer";
import { Request, Response } from "express";
import { Conversation } from "../client";
import { mulaw } from "alawmulaw";

export class TwilioIntegration {
  isOn: boolean;

  constructor(isOn: boolean = false, app: any) {
    if (!isOn) return;

    this.isOn = isOn;
    this.configureRoutes(app);

    console.log("Twilio integration initialized");
  }

  public configureRoutes(app: any): void {
    if (!this.isOn) return;

    app.all("/twilio/incoming-call", this.handleIncomingCall.bind(this));
    app.all("/twilio/failover", this.handleFailover.bind(this));
  }

  private handleIncomingCall(req: Request, res: Response): void {
    console.log("Twilio incoming call");
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say>You've been connected.</Say>
        <Connect>
          <Stream url="wss://${req.headers.host}/socket" />
        </Connect>
      </Response>`;

    res.type("text/xml").send(twimlResponse);
  }

  private handleFailover(req: Request, res: Response): void {
    // If you have a SIP endpoint for failover
    const sipEndpoint = process.env.SIP_ENDPOINT || "";
    const sipTwiml = `
      <Response>
        <Say>Hang on for a moment while I forward the call to a human agent</Say>
        <Pause length="1"/>
        <Dial>
          <Sip>${sipEndpoint}</Sip>
        </Dial>
      </Response>`;

    res.type("text/xml").send(sipTwiml);
  }

  private messageHandlers = new Map<
    string,
    (jsonMsg: any, conversation: Conversation) => Promise<void>
  >([
    [
      "start",
      async (jsonMsg, conversation) => {
        conversation.twilioStreamSid = jsonMsg.streamSid;
        console.log(`Started twilio with streamId=${conversation.twilioStreamSid}`);
      }
    ],
    [
      "media",
      async (jsonMsg, conversation) => {
        const audioInput = Buffer.from(jsonMsg.media.payload, "base64");
        const pcmSamples = mulaw.decode(audioInput);
        const audioBuffer = Buffer.from(pcmSamples.buffer);
        await conversation.streamAudio(audioBuffer);
      },
    ],
  ]);

  public async tryProcessAudioInput(
    msg: string,
    conversation: Conversation
  ): Promise<void> {
    if (!this.isOn) return;

    const data = JSON.parse(msg.toString());

    try {
      const handler = this.messageHandlers.get(data.event);
      handler
        ? await handler(data, conversation)
        : console.error("Caught unclassified Twilio message:", data);
    } catch (error) {
      console.error("Error processing Twilio audio data:", error);
    }
  }

  public async tryProcessAudioOutput(
    pcmSamples: Int16Array,
    clients: any,
    streamSid: string
  ): Promise<void> {
    if (!this.isOn) return;

    try {
      const resampledPcmSamples = this.resample16kHzTo8kHz(pcmSamples)
      const mulawSamples = mulaw.encode(resampledPcmSamples);
      const payload = Buffer.from(mulawSamples).toString("base64");
      const response = JSON.stringify({
        event: "media",
        media: {
          track: "outbound",
          payload,
        },
        streamSid
      });
      console.log("response", response)

      clients?.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(response);
      });
    } catch (e) {
      console.log("An error occurred processing Twilio audio output:", e)
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
