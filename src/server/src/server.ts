import "dotenv/config";
import * as https from "https";
import { WebSocket } from "ws";
import bodyParser from "body-parser";
import express, { Request, Response } from "express";
import expressWs from "express-ws";
import { BrowserIntegration } from "./telephony/browser";
import { Buffer } from "node:buffer";
import { Conversation, NovaSonicBidirectionalStreamClient } from "./client";
import { Session, SessionEventData } from "./types";
import { TwilioIntegration } from "./telephony/twilio";
import { VonageIntegration } from "./telephony/vonage";
import { fromEnv } from "@aws-sdk/credential-providers";
import { v4 as uuidv4 } from "uuid";

const app = express();
const wsInstance = expressWs(app);
app.use(bodyParser.json());

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

function isTrue(s: string | undefined) {
  return s?.toLowerCase() === "true";
}

const browser = new BrowserIntegration(
  isTrue(process.env.BROWSER_ENABLED),
  app
);
const vonage = new VonageIntegration(isTrue(process.env.VONAGE_ENABLED), app);
const twilio = new TwilioIntegration(isTrue(process.env.TWILIO_ENABLED), app);

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
      console.log(`Closing inactive conversation ${sessionId} due to inactivity.`);
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
const channelConversations = new Map<string, Conversation>(); // conversationId -> Session
const channelClients = new Map<string, Set<WebSocket>>(); // conversationId -> Set of clients
const clientChannels = new Map<WebSocket, string>(); // WebSocket client -> conversationId

wsInstance.getWss().on("connection", (ws: WebSocket) => {
  console.log("Websocket connection is open");
});

export function setUpEventHandlersForChannel(conversation: Conversation) {
  console.log("conversation", conversation)
  function handleConversationEvent(
    conversation: Conversation,
    eventName: string,
    isError: boolean = false
  ) {
    conversation.setupOnEvent(eventName, (data: SessionEventData) => {
      console[isError ? "error" : "debug"](eventName, data);

      // Broadcast to all clients in this channel
      const clients = channelClients.get(conversation.id) || new Set();
      const message = JSON.stringify({ event: { [eventName]: { ...data } } });

      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    });
  }

  handleConversationEvent(conversation, "contentStart");
  handleConversationEvent(conversation, "textOutput");
  handleConversationEvent(conversation, "error", true);
  handleConversationEvent(conversation, "toolUse");
  handleConversationEvent(conversation, "toolResult");
  handleConversationEvent(conversation, "contentEnd");

  conversation.setupOnEvent("streamComplete", () => {
    console.log("Stream completed for channel:", conversation.id);

    const clients = channelClients.get(conversation.id) || new Set();
    const message = JSON.stringify({ event: "streamComplete" });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    });
  });

  conversation.setupOnEvent("audioOutput", (data: SessionEventData) => {
    const CHUNK_SIZE_BYTES = 640;
    const SAMPLES_PER_CHUNK = CHUNK_SIZE_BYTES / 2;

    const clients = channelClients.get(conversation.id) || new Set();

    const buffer = Buffer.from(data["content"], "base64");
    const pcmSamples = new Int16Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / Int16Array.BYTES_PER_ELEMENT
    );

    let offset = 0;
    // Default way to send audio samples to the websocket clients.
    while (offset + SAMPLES_PER_CHUNK <= pcmSamples.length) {
      const chunk = pcmSamples.slice(offset, offset + SAMPLES_PER_CHUNK);
      clients?.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(chunk);
      });
      offset += SAMPLES_PER_CHUNK;
    }
    // Twilio takes a different format for audio samples.
    if (twilio.isOn)
      twilio.tryProcessAudioOutput(pcmSamples, clients, conversation.twilioStreamSid!);
    if (browser.isOn) browser.tryProcessAudioOutput(data, clients);
  });
}

wsInstance.app.ws("/socket", (ws: WebSocket, req: Request) => {
  // Get channel from query parameters or use a default
  const conversationId = req.query.channel?.toString() || uuidv4();
  console.log(`Client requesting connection to channel: ${conversationId}`);

  const sendError = (message: string, details: string) => {
    const errorMsg = JSON.stringify({ event: "error", data: { message, details } })
    console.log(`Sending error ${errorMsg}`)
    ws.send(JSON.stringify({ event: "error", data: { message, details } }));
  };

  async function tryProcessNovaSonicMessage(msg: any, conversation: Conversation) {
    try {
      const jsonMsg = JSON.parse(msg.toString());

      // Create handler functions.
      const handlePromptStart = async (jsonMsg, conversation) =>
        await conversation.setupPromptStart();
      const handleSystemPrompt = async (jsonMsg, conversation) =>
        await conversation.setupSystemPrompt(undefined, jsonMsg.data);
      const handleAudioStart = async (jsonMsg, conversation) =>
        await conversation.setupStartAudio();
      const handleStopAudio = async (jsonMsg, conversation) => {
        await conversation.endAudioContent();
        await conversation.endPrompt();
      };

      // Create map of [ messageTag -> handlerFunction ]
      let novaSonicHandlers = new Map<
        string,
        (jsonMsg: any, conversation: Conversation) => Promise<void>
      >([
        ["promptStart", handlePromptStart],
        ["systemPrompt", handleSystemPrompt],
        ["audioStart", handleAudioStart],
        ["stopAudio", handleStopAudio],
      ]);

      // Try use JSON messages with `.event` prop.
      let handler = novaSonicHandlers.get(jsonMsg.type);
      if (handler) await handler(jsonMsg, conversation);
    } catch (e) {}
  }

  const initializeOrJoinChannel = async () => {
    try {
      let conversation: Conversation;
      let isNewChannel = false;

      if (channelConversations.has(conversationId)) {
        console.log(`Client joining existing channel: ${conversationId}`);
        conversation = channelConversations.get(conversationId)!;
      } else {
        console.log(`Creating new channel: ${conversationId}`);
        conversation = bedrockClient.createConversation(conversationId, ws);
        await conversation.startSession()

        channelConversations.set(conversation.id, conversation);
        channelClients.set(conversation.id, new Set());
        isNewChannel = true;
      }

      // Add this client to the channel.
      const clients = channelClients.get(conversation.id)!;
      clients.add(ws);
      clientChannels.set(ws, conversation.id);

      console.log(`Channel ${conversation.id} has ${clients.size} connected clients`);

      // Notify client that connection is successful.
      ws.send(
        JSON.stringify({
          event: "sessionReady",
          message: `Connected to channel ${conversation.id}`,
          isNewChannel: isNewChannel,
        })
      );
    } catch (error) {
      sendError("Failed to initialize or join channel", String(error));
      ws.close();
    }
  };

  const handleMessage = async (msg: Buffer | string) => {
    const conversationId = clientChannels.get(ws);
    if (!conversationId) {
      sendError("Channel not found", "No active channel for this connection");
      return;
    }

    const conversation = channelConversations.get(conversationId);
    if (!conversation) {
      sendError("Conversation not found", "No active conversation for this channel");
      return;
    }

    try {
      if (browser.isOn)
        await browser.tryProcessAudioInput(msg as Buffer, conversation);
      if (vonage.isOn)
        await vonage.tryProcessAudioInput(msg as Buffer, conversation);
      if (twilio.isOn)
        await twilio.tryProcessAudioInput(msg as string, conversation);
      await tryProcessNovaSonicMessage(msg, conversation);
    } catch (error) {
      sendError("Error processing message", String(error));
    }
  };

  const handleClose = async () => {
    const conversationId = clientChannels.get(ws);
    if (!conversationId) {
      console.log("No channel to clean up for this connection");
      return;
    }

    const clients = channelClients.get(conversationId);
    if (clients) {
      clients.delete(ws);
      console.log(
        `Client disconnected from channel ${conversationId}, ${clients.size} clients remaining`
      );

      // If this was the last client, clean up the channel
      if (clients.size === 0) {
        console.log(
          `Last client left channel ${conversationId}, cleaning up resources`
        );

        const session = channelConversations.get(conversationId);
        if (session && bedrockClient.isSessionActive(conversationId)) {
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
            console.log(`Successfully cleaned up channel: ${conversationId}`);
          } catch (error) {
            console.error(`Error cleaning up channel ${conversationId}:`, error);
            try {
              bedrockClient.closeSession(conversationId);
              console.log(`Force closed session for channel: ${conversationId}`);
            } catch (e) {
              console.error(
                `Failed to force close session for channel ${conversationId}:`,
                e
              );
            }
          }
        }

        channelConversations.delete(conversationId);
        channelClients.delete(conversationId);
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

    for (const [sessionId, session] of channelConversations.entries()) {
      console.log(`Closing session for channel ${sessionId} during shutdown`);

      sessionPromises.push(bedrockClient.closeSession(sessionId));

      const clients = channelClients.get(sessionId) || new Set();
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

// TODO: Fix this - it's broken due to the convo / session distinction
// Add endpoint to list active channels
///*
app.get("/channels", (req: Request, res: Response) => {
  const channels = [];
  for (const [conversationId, clients] of channelClients.entries()) {
    const json = {
      id: conversationId,
      clientCount: clients.size,
      active: bedrockClient.isSessionActive(conversationId),
    }
    console.log(379, json)
    channels.push(json);
  }
  res.status(200).json({ channels });
});
//*/
