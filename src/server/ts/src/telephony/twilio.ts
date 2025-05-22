import { Request, Response } from "express";
import { Twilio, twiml } from "twilio";
import { mulaw } from "alawmulaw";
import { Session } from "./types";
import WebSocket from "ws";
import { Buffer } from "node:buffer";

export class TwilioIntegration {
  private twClient: Twilio;
  private channelStreams: Map<string, Session>;
  private useTwilio: boolean;

  constructor(
    useTwilioFlag: boolean = false,
    channelStreamsMap: Map<string, Session>,
    apiSid?: string,
    apiSecret?: string,
    accountSid?: string
  ) {
    this.useTwilio = useTwilioFlag;
    this.channelStreams = channelStreamsMap;

    if (this.useTwilio) {
      if (!apiSid || !apiSecret || !accountSid) {
        console.warn("Twilio credentials not fully provided but useTwilio is true");
      }
      this.twClient = new Twilio(apiSid, apiSecret, { accountSid });
      console.log("Twilio integration initialized");
    }
  }

  public configureRoutes(app: any): void {
    if (!this.useTwilio) return;

    app.all("/incoming-call", this.handleIncomingCall.bind(this));
    app.all("/failover", this.handleFailover.bind(this));
    app.get("/media-stream", { websocket: true }, this.handleMediaStream.bind(this));
  }

  private handleIncomingCall(req: Request, res: Response): void {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say>Please wait while we connect your call to the AI assistant</Say>
        <Pause length="1"/>
        <Say>OK, you can start talking!</Say>
        <Connect>
          <Stream url="wss://${req.headers.host}/media-stream" />
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

  private handleMediaStream(connection: WebSocket, req: any): void {
    console.log("Twilio media stream client connected");

    let sessionId = "";
    let session: Session | null = null;
    let callSid = "";

    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.event) {
          case "connected":
            console.log(`Twilio WebSocket connected: ${message}`);
            break;

          case "start":
            sessionId = data.streamSid;
            callSid = data.start.callSid;
            console.log(`Twilio stream started: streamSid: ${sessionId}, callSid: ${callSid}`);

            // Find or create session
            if (this.channelStreams.has(sessionId)) {
              session = this.channelStreams.get(sessionId)!;
            } else {
              console.error("No session available for Twilio stream");
              connection.close();
              return;
            }

            await session.setupPromptStart();
            await session.setupSystemPrompt(
              undefined,
              `You are an AI assistant having a voice conversation over a phone call. 
              Keep responses concise and conversational. Remember that the user can only 
              hear you, not see you, so describe any visual information.
              You must always be helpful and friendly.`
            );
            await session.setupStartAudio();
            break;

          case "media":
            if (!session || !sessionId) break;
            
            // Convert from 8-bit mulaw to 16-bit LPCM
            const audioInput = Buffer.from(data.media.payload, "base64");
            const pcmSamples = mulaw.decode(audioInput);
            const audioBuffer = Buffer.from(pcmSamples.buffer);
            
            // Stream audio to session
            await session.streamAudio(audioBuffer);
            break;

          case "stop":
            console.log(`Twilio stream stopped: ${sessionId}`);
            if (session) {
              await session.endAudioContent();
              await session.endPrompt();
            }
            break;

          default:
            console.log(`Received non-media Twilio event: ${data.event}`);
            break;
        }
      } catch (error) {
        console.error("Error processing Twilio message:", error);
      }
    });

    connection.on("close", async () => {
      console.log("Twilio media stream client disconnected");
      if (session) {
        try {
          await session.endAudioContent();
          await session.endPrompt();
        } catch (error) {
          console.error("Error cleaning up Twilio session:", error);
        }
      }
    });

    // Set up audio output handler for this connection
    if (sessionId && this.channelStreams.has(sessionId)) {
      const session = this.channelStreams.get(sessionId)!;
      
      session.onEvent("audioOutput", (data) => {
        // Decode base64 to get the PCM buffer
        const buffer = Buffer.from(data["content"], "base64");
        
        // Convert to Int16Array
        const pcmSamples = new Int16Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.length / Int16Array.BYTES_PER_ELEMENT
        );
        
        // Encode to mulaw (8-bit)
        const mulawSamples = mulaw.encode(pcmSamples);
        
        // Convert to base64
        const payload = Buffer.from(mulawSamples).toString("base64");

        // Send formatted audio back to Twilio
        const audioResponse = {
          event: "media",
          media: {
            track: "outbound",
            payload
          },
          streamSid: sessionId
        };

        if (connection.readyState === WebSocket.OPEN) {
          connection.send(JSON.stringify(audioResponse));
        }
      });
    }
  }

  public async transferToHuman(callSid: string): Promise<void> {
    if (!this.useTwilio || !callSid) return;

    try {
      const sipEndpoint = process.env.SIP_ENDPOINT || "";
      const sipTwiml = `
        <Response>
          <Say>Transferring you to a human agent now</Say>
          <Dial>
            <Sip>${sipEndpoint}</Sip>
          </Dial>
        </Response>`;

      await this.twClient.calls(callSid).update({ twiml: sipTwiml });
      console.log(`Successfully transferred call ${callSid} to human agent`);
    } catch (error) {
      console.error(`Failed to transfer call ${callSid}:`, error);
    }
  }
}