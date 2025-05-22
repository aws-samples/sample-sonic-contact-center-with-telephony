import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import expressWs from "express-ws";
import * as https from "https";
import { fromEnv } from "@aws-sdk/credential-providers";
import { NovaSonicBidirectionalStreamClient } from "./client";
import { Buffer } from "node:buffer";
import WebSocket from "ws";
import {
  Session,
  SessionEventData,
} from "./types";
import { v4 as uuidv4 } from "uuid";
import { VonageIntegration } from "./telephony/vonage";
// import { TwilioIntegration } from "./telephony/twilio";

const app = express();
const wsInstance = expressWs(app);
app.use(bodyParser.json());

const AWS_PROFILE_NAME: string = process.env.AWS_PROFILE || "";
const bedrockClient = new NovaSonicBidirectionalStreamClient({
  requestHandlerConfig: {
    maxConcurrentStreams: 10,
  },
  clientConfig: {
    region: process.env.AWS_REGION || "us-east-1",
    credentials: fromEnv(),
  },
});

// Integrations
const useJson: boolean = true;
const vonage = new VonageIntegration(true)
vonage.configureRoutes(app)
// new TwilioIntegration(useTwilio).configureRoutes(app)

/* Periodically check for and close inactive sessions (every minute).
 * Sessions with no activity for over 5 minutes will be force closed
 */
setInterval(() => {
  console.log("Running session cleanup check");
  const now = Date.now();

  bedrockClient.getActiveSessions().forEach((sessionId: string) => {
    const lastActivity = bedrockClient.getLastActivityTime(sessionId);

    const fiveMinsInMs = 5 * 60 * 1000;
    if (now - lastActivity > fiveMinsInMs) {
      console.log(`Closing inactive session ${sessionId} due to inactivity.`);
      try {
        bedrockClient.closeSession(sessionId);
      } catch (error: unknown) {
        console.error(
          `Error force closing inactive session ${sessionId}:`,
          error
        );
      }
    }
  });
}, 60000);

// Track active websocket connections with their session IDs
const channelStreams = new Map<string, Session>(); // channelId -> Session
const channelClients = new Map<string, Set<WebSocket>>(); // channelId -> Set of connected clients
const clientChannels = new Map<WebSocket, string>(); // WebSocket -> channelId

wsInstance.getWss().on("connection", (ws: WebSocket) => {
  console.log("Websocket connection is open");
});

function setUpEventHandlersForChannel(session: Session, channelId: string) {
  function handleSessionEvent(
    session: Session,
    channelId: string,
    eventName: string,
    isError: boolean = false
  ) {
    session.onEvent(eventName, (data: SessionEventData) => {
      console[isError ? "error" : "debug"](eventName, data);

      // Broadcast to all clients in this channel
      const clients = channelClients.get(channelId) || new Set();
      const message = JSON.stringify({ event: { [eventName]: { ...data } } });

      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    });
  }

  handleSessionEvent(session, channelId, "contentStart");
  handleSessionEvent(session, channelId, "textOutput");
  handleSessionEvent(session, channelId, "error", true);
  handleSessionEvent(session, channelId, "toolUse");
  handleSessionEvent(session, channelId, "toolResult");
  handleSessionEvent(session, channelId, "contentEnd");

  session.onEvent("streamComplete", () => {
    console.log("Stream completed for channel:", channelId);

    const clients = channelClients.get(channelId) || new Set();
    const message = JSON.stringify({ event: "streamComplete" });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    });
  });

  session.onEvent("audioOutput", (data: SessionEventData) => {
    // Process audio data as before
    let audioBuffer: Int16Array | null = null;
    const CHUNK_SIZE_BYTES = 640;
    const SAMPLES_PER_CHUNK = CHUNK_SIZE_BYTES / 2;

    const buffer = Buffer.from(data["content"], "base64");
    const newPcmSamples = new Int16Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / Int16Array.BYTES_PER_ELEMENT
    );

    const clients = channelClients.get(channelId) || new Set();

    if (useJson) {
      const message = JSON.stringify({ event: { audioOutput: { ...data } } });
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
      });
    }

    let offset = 0;
    while (offset + SAMPLES_PER_CHUNK <= newPcmSamples.length) {
      const chunk = newPcmSamples.slice(offset, offset + SAMPLES_PER_CHUNK);

      clients?.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(chunk);
      });

      offset += SAMPLES_PER_CHUNK;
    }

    audioBuffer =
      offset < newPcmSamples.length ? newPcmSamples.slice(offset) : null;
  });
}

wsInstance.app.ws("/socket", (ws: WebSocket, req: Request) => {
  // Get channel from query parameters or use a default
  const channelId = req.query.channel?.toString() || uuidv4();
  console.log(`Client requesting connection to channel: ${channelId}`);

  const sendError = (message: string, details: string) => {
    ws.send(JSON.stringify({ event: "error", data: { message, details } }));
  };

  const initializeOrJoinChannel = async () => {
    try {
      let session: Session;
      let isNewChannel = false;

      // Check if channel exists
      if (channelStreams.has(channelId)) {
        console.log(`Client joining existing channel: ${channelId}`);
        session = channelStreams.get(channelId)!;
      } else {
        // Create new session for this channel
        console.log(`Creating new channel: ${channelId}`);
        session = bedrockClient.createStreamSession(channelId);
        bedrockClient.initiateSession(channelId);
        channelStreams.set(channelId, session);
        channelClients.set(channelId, new Set());

        setUpEventHandlersForChannel(session, channelId);
        await session.setupPromptStart();
        await session.setupSystemPrompt(
          undefined,
          `You are Telly, an AI assistant having a voice conversation. Keep responses concise and conversational.
          You must always check what the next script item is, and you must always use the script as a starting
          point to decide what to respond the user and what tools to use. You must always rely on your script 
          to find what to say. You must not change or embellish the script; just present the script to the user,
          and present them with their options if there are any. No matter what the user says, you should start 
          by checking the script. You must not tell the user about the script. You must always present the options
          to the user with numbers. If the script tells you to check your tools, you are then allowed to deviate
          from the script.
          You can also cook scallops.
          Before every response to the user, you MUST check if you have any messages to pass on to the user.
          `
        );
        await session.setupStartAudio();

        isNewChannel = true;
      }

      // Add this client to the channel.
      const clients = channelClients.get(channelId)!;
      clients.add(ws);
      clientChannels.set(ws, channelId);

      console.log(`Channel ${channelId} has ${clients.size} connected clients`);

      // Notify client that connection is successful.
      ws.send(
        JSON.stringify({
          event: "sessionReady",
          message: `Connected to channel ${channelId}`,
          isNewChannel: isNewChannel,
        })
      );
    } catch (error) {
      sendError("Failed to initialize or join channel", String(error));
      ws.close();
    }
  };

  const handleMessage = async (msg: Buffer | string) => {
    const channelId = clientChannels.get(ws);
    if (!channelId) {
      sendError("Channel not found", "No active channel for this connection");
      return;
    }

    const session = channelStreams.get(channelId);
    if (!session) {
      sendError("Session not found", "No active session for this channel");
      return;
    }

    try {
      let audioBuffer: Buffer | undefined;
      try {
        const jsonMsg = JSON.parse(msg.toString());
        if (jsonMsg.type) console.log("Event received of type:", jsonMsg.type);
        switch (jsonMsg.type) {
          case "promptStart":
            await session.setupPromptStart();
            break;
          case "systemPrompt":
            await session.setupSystemPrompt(undefined, jsonMsg.data);
            break;
          case "audioStart":
            await session.setupStartAudio();
            break;
          case "stopAudio":
            await session.endAudioContent();
            await session.endPrompt();
            console.log("Session cleanup complete");
            break;
          default:
            break;
        }
      } catch (e) {
        if (vonage.isOn) await vonage.processAudioData(msg as Buffer, session)
      } finally {
        if (useJson) {
          const msgJson = JSON.parse(msg.toString());
          // TODO: We shouldn't do this.
          audioBuffer = Buffer.from(msgJson.event.audioInput.content, "base64");
          await session.streamAudio(audioBuffer);
        }
      }
    } catch (error) {
      sendError("Error processing message", String(error));
    }
  };

  const handleClose = async () => {
    const channelId = clientChannels.get(ws);
    if (!channelId) {
      console.log("No channel to clean up for this connection");
      return;
    }

    const clients = channelClients.get(channelId);
    if (clients) {
      clients.delete(ws);
      console.log(
        `Client disconnected from channel ${channelId}, ${clients.size} clients remaining`
      );

      // If this was the last client, clean up the channel
      if (clients.size === 0) {
        console.log(
          `Last client left channel ${channelId}, cleaning up resources`
        );

        const session = channelStreams.get(channelId);
        if (session && bedrockClient.isSessionActive(channelId)) {
          try {
            await Promise.race([
              (async () => {
                await session.endAudioContent();
                await session.endPrompt();
                await session.close();
              })(),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("Session cleanup timeout")),
                  3000
                )
              ),
            ]);
            console.log(`Successfully cleaned up channel: ${channelId}`);
          } catch (error) {
            console.error(`Error cleaning up channel ${channelId}:`, error);
            try {
              bedrockClient.closeSession(channelId);
              console.log(`Force closed session for channel: ${channelId}`);
            } catch (e) {
              console.error(
                `Failed to force close session for channel ${channelId}:`,
                e
              );
            }
          }
        }

        channelStreams.delete(channelId);
        channelClients.delete(channelId);
      }
    }
    clientChannels.delete(ws);
  };

  initializeOrJoinChannel();
  ws.on("message", handleMessage);
  ws.on("close", handleClose);
});

/* SERVER LOGIC */

const port: number = 3001;
const server = app.listen(port, () =>
  console.log(`Original server listening on port ${port}`)
);

const httpsPort: number = 443;
const httpsServer = https.createServer(app).listen(httpsPort, () => {
  console.log(`HTTPS server listening on port ${httpsPort}`);
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Gracefully shut down.
process.on("SIGINT", async () => {
  console.log("Shutting down servers...");

  const forceExitTimer = setTimeout(() => {
    console.error("Forcing server shutdown after timeout");
    process.exit(1);
  }, 5000);

  try {
    const sessionPromises: Promise<void>[] = [];

    for (const [channelId, session] of channelStreams.entries()) {
      console.log(`Closing session for channel ${channelId} during shutdown`);

      sessionPromises.push(bedrockClient.closeSession(channelId));

      const clients = channelClients.get(channelId) || new Set();
      clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
    }

    await Promise.all(sessionPromises);
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => httpsServer.close(resolve)),
    ]);

    clearTimeout(forceExitTimer);
    console.log("Servers shut down");
    process.exit(0);
  } catch (error: unknown) {
    console.error("Error during server shutdown:", error);
    process.exit(1);
  }
});

// Add endpoint to list active channels
app.get("/channels", (req: Request, res: Response) => {
  const channels = [];
  for (const [channelId, clients] of channelClients.entries()) {
    channels.push({
      id: channelId,
      clientCount: clients.size,
      active: bedrockClient.isSessionActive(channelId),
    });
  }
  res.status(200).json({ channels });
});