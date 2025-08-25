import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  InvokeModelWithBidirectionalStreamInput,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { InferenceConfig } from "./types";
import { Subject } from "rxjs";
import { take } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  DefaultAudioInputConfiguration,
  DefaultAudioOutputConfiguration,
  DefaultSystemPrompt,
  DefaultTextConfiguration,
} from "./consts";
import { SessionData, NovaSonicBidirectionalStreamClientConfig } from "./types";
import { ToolRegistry } from "./tools/ToolRegistry";
import { WebSocket } from "ws";
import { setUpEventHandlersForChannel } from "./server";

enum cutoverState {
  readyToPrepare,
  waiting,
}

const TIME_TO_PREPARE_CUTOVER_IN_S = 5 * 60 * 1000;  // 5 minutes.

export class Conversation {
  public id: string;
  private nextSession: StreamSession | null;
  public sessionId: string;
  public twilioStreamSid: string | null;
  public session: StreamSession | null;
  public conversationHistory: Array<{ content: string; role: string }> = [];
  private useAllStreams: boolean = false;

  constructor(
    private client: NovaSonicBidirectionalStreamClient,
    private ws: WebSocket,
    private clientConfig?: NovaSonicBidirectionalStreamClientConfig
  ) {
    this.id = randomUUID();
  }

  isReadyToPrepareCutover() {
    const timeSinceSessionStart = Date.now() - this.session.startTime;
    return (
      timeSinceSessionStart > TIME_TO_PREPARE_CUTOVER_IN_S && !this.nextSession
    );
  }

  async startSession() {
    await this.initiateNextSession();
    this.cutOver();
  }

  async initiateNextSession() {
    // Stream to all sessions until we cut over.
    const newSessionId = randomUUID();
    console.log(`Creating session ${newSessionId}`);

    this.nextSession = this.client.createStreamSession(
      newSessionId,
      this.clientConfig
    );
    this.client.initiateSession(this.ws, this, this.nextSession.sessionId);

    await this.nextSession.setupPromptStart();
    await this.nextSession.setupSystemPrompt(
      DefaultTextConfiguration,
      `You are Telly, an AI assistant having a voice conversation. Keep responses concise and conversational.
          You must always check what the next script item is, and you must always use the script as a starting
          point to decide what to respond the user and what tools to use. You must always rely on your script
          to find what to say. You must not change or embellish the script; just present the script to the user,
          and present them with their options if there are any. No matter what the user says, you should start
          by checking the script. You must not tell the user about the script. You must always present the options
          to the user with numbers. If the script tells you to check your tools, you are then allowed to deviate
          from the script.
          Before every response to the user, you MUST check if you have any messages to pass on to the user.
          `
    );
    await this.nextSession.setupStartAudio(DefaultAudioInputConfiguration);
    setUpEventHandlersForChannel(this);
    this.useAllStreams = true;
  }

  cutOver() {
    console.log(
      `Cutting over from ${this.session?.sessionId} to ${this.nextSession.sessionId}.`
    );

    // Transfer conversation history to the new session
    if (this.conversationHistory.length > 0) {
      console.log(
        `Transferring ${this.conversationHistory.length} history items to new session`
      );
      for (const historyItem of this.conversationHistory) {
        this.nextSession.setupHistoryForConversationResumtion(
          undefined,
          historyItem.content,
          historyItem.role
        );
      }

    }

    this.session = this.nextSession;
    this.nextSession = null;
    this.useAllStreams = false;
    console.log("Cutover complete.");
  }

  public setupOnEvent(
    eventType: string,
    handler: (data: any) => void
  ): StreamSession {
    return this.nextSession.onEvent(eventType, handler);
  }

  public onEvent(
    eventType: string,
    handler: (data: any) => void
  ): StreamSession {
    if (this.useAllStreams) this.nextSession.onEvent(eventType, handler);
    return this.session.onEvent(eventType, handler);
  }

  async setupStartAudio(
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): Promise<void> {
    return this.session.setupStartAudio(audioConfig);
  }

  async streamAudio(audioData: Buffer): Promise<void> {
    if (this.useAllStreams) this.nextSession.streamAudio(audioData)
    return this.session.streamAudio(audioData);
  }

  async endAudioContent(): Promise<void> {
    if (this.useAllStreams) this.nextSession.endAudioContent()
    return this.session.endAudioContent();
  }

  async endPrompt(): Promise<void> {
    if (this.useAllStreams) this.nextSession.endPrompt()
    return this.session.endPrompt();
  }

  async close(): Promise<void> {
    return this.session.close();
  }
}

export class StreamSession {
  public audioBufferQueue: Buffer[] = [];
  public maxQueueSize = 200; // Maximum number of audio chunks to queue
  public isProcessingAudio = false;
  public isActive = true;
  public startTime: number;

  constructor(
    public sessionId: string,
    public client: NovaSonicBidirectionalStreamClient
  ) {
    this.startTime = Date.now();
  }

  public async setupHistoryForConversationResumtion(
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    content: string,
    role: string
  ): Promise<void> {
    this.client.setupHistoryEventForConversationResumption(
      this.sessionId,
      textConfig,
      content,
      role
    );
  }

  public onEvent(
    eventType: string,
    handler: (data: any) => void
  ): StreamSession {
    this.client.registerEventHandler(this.sessionId, eventType, handler);
    return this; // For chaining
  }

  public async setupPromptStart(): Promise<void> {
    this.client.setupPromptStartEvent(this.sessionId);
  }

  public async setupSystemPrompt(
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = DefaultSystemPrompt
  ): Promise<void> {
    this.client.setupSystemPromptEvent(
      this.sessionId,
      textConfig,
      systemPromptContent
    );
  }

  public async setupStartAudio(
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): Promise<void> {
    this.client.setupStartAudioEvent(this.sessionId, audioConfig);
  }

  public async streamAudio(audioData: Buffer): Promise<void> {
    if (this.audioBufferQueue.length >= this.maxQueueSize) {
      this.audioBufferQueue.shift();
      console.log(
        `Audio queue full (${this.audioBufferQueue.length} exceeds max size {this.maxQueueSize}), dropping oldest chunk`
      );
    }

    this.audioBufferQueue.push(audioData);
    this.processAudioQueue();
  }

  private async processAudioQueue() {
    if (
      this.isProcessingAudio ||
      this.audioBufferQueue.length === 0 ||
      !this.isActive
    )
      return;

    this.isProcessingAudio = true;
    try {
      let processedChunks = 0;
      const maxChunksPerBatch = 5;

      while (
        this.audioBufferQueue.length > 0 &&
        processedChunks < maxChunksPerBatch &&
        this.isActive
      ) {
        const audioChunk = this.audioBufferQueue.shift();
        if (audioChunk) {
          // console.log("219")
          await this.client.streamAudioChunk(this.sessionId, audioChunk);
          processedChunks++;
        }
      }
    } finally {
      this.isProcessingAudio = false;

      if (this.audioBufferQueue.length > 0 && this.isActive) {
        setTimeout(() => this.processAudioQueue(), 0);
      }
    }
  }

  public async endAudioContent(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendContentEnd(this.sessionId);
  }

  public async endPrompt(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendPromptEnd(this.sessionId);
  }

  public async close(): Promise<void> {
    if (!this.isActive) return;

    this.isActive = false;
    this.audioBufferQueue = [];

    await this.client.sendSessionEnd(this.sessionId);
    console.log(`Session ${this.sessionId} close completed`);
  }
}

export class NovaSonicBidirectionalStreamClient {
  private bedrockRuntimeClient: BedrockRuntimeClient;
  private inferenceConfig: InferenceConfig;
  public activeSessions: Map<string, SessionData> = new Map();
  private sessionLastActivity: Map<string, number> = new Map();
  private sessionCleanupInProgress = new Set<string>();
  private toolRegistry = new ToolRegistry();
  public contentNames: Map<string, string> = new Map();

  constructor(config: NovaSonicBidirectionalStreamClientConfig) {
    const nodeHttp2Handler = new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 300000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
      ...config.requestHandlerConfig,
    });

    if (!config.clientConfig.credentials) {
      throw new Error("No credentials provided");
    }

    this.bedrockRuntimeClient = new BedrockRuntimeClient({
      ...config.clientConfig,
      credentials: config.clientConfig.credentials,
      region: config.clientConfig.region || "us-east-1",
      requestHandler: nodeHttp2Handler,
    });

    this.inferenceConfig = config.inferenceConfig ?? {
      maxTokens: 1024,
      topP: 0.9,
      temperature: 0.7,
    };
  }

  public setupHistoryEventForConversationResumption(
    sessionId: string,
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    content: string,
    role: string
  ): void {
    console.log(`Setting up systemPrompt events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    // Text content start
    const textPromptID = randomUUID();
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: textPromptID,
          type: "TEXT",
          interactive: true,
          textInputConfiguration: textConfig,
        },
      },
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: textPromptID,
          content: content,
          role: role,
        },
      },
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: textPromptID,
        },
      },
    });
  }

  isSessionActive(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return !!session && session.isActive;
  }

  public getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  public getLastActivityTime(sessionId: string): number {
    return this.sessionLastActivity.get(sessionId) || 0;
  }

  private updateSessionActivity(sessionId: string): void {
    this.sessionLastActivity.set(sessionId, Date.now());
  }

  public isCleanupInProgress(sessionId: string): boolean {
    return this.sessionCleanupInProgress.has(sessionId);
  }

  public createConversation(
    sessionId: string = randomUUID(),
    ws: WebSocket,
    config?: NovaSonicBidirectionalStreamClientConfig
  ): Conversation {
    return new Conversation(this, ws, config);
  }

  public createStreamSession(
    sessionId: string = randomUUID(),
    config?: NovaSonicBidirectionalStreamClientConfig
  ): StreamSession {
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Stream session with ID ${sessionId} already exists`);
    }

    const session: SessionData = {
      queue: [],
      queueSignal: new Subject<void>(),
      closeSignal: new Subject<void>(),
      responseSubject: new Subject<any>(),
      toolUseContent: null,
      toolUseId: "",
      toolName: "",
      responseHandlers: new Map(),
      promptName: randomUUID(),
      inferenceConfig: config?.inferenceConfig ?? this.inferenceConfig,
      isActive: true,
      isPromptStartSent: false,
      isAudioContentStartSent: false,
      audioContentId: randomUUID(),
    };

    this.activeSessions.set(sessionId, session);

    return new StreamSession(sessionId, this);
  }

  public async initiateSession(
    ws: WebSocket,
    conversation: Conversation,
    sessionId: string
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Stream session ${sessionId} not found`);
    }

    try {
      this.setupSessionStartEvent(sessionId);

      const asyncIterable = this.createSessionAsyncIterable(sessionId);

      console.log(`Starting Nova Sonic stream for session ${sessionId}...`);

      const response = await this.bedrockRuntimeClient.send(
        new InvokeModelWithBidirectionalStreamCommand({
          modelId: "amazon.nova-sonic-v1:0",
          body: asyncIterable,
        })
      );

      console.log(
        `Nova Sonic stream established for sessionId ${sessionId}, processing responses...`
      );

      await this.processResponseStream(ws, conversation, sessionId, response);
    } catch (error) {
      console.error(`Error in session ${sessionId}: `, error);
      this.dispatchEventForSession(sessionId, "error", {
        source: "bidirectionalStream",
        error,
      });

      if (session.isActive) this.closeSession(sessionId);
    }
  }

  private dispatchEventForSession(
    sessionId: string,
    eventType: string,
    data: any
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try {
        handler(data);
      } catch (e) {
        console.error(
          `Error in ${eventType} handler for session ${sessionId}: `,
          e
        );
      }
    }

    const anyHandler = session.responseHandlers.get("any");
    if (anyHandler) {
      try {
        anyHandler({ type: eventType, data });
      } catch (e) {
        console.error(`Error in 'any' handler for session ${sessionId}: `, e);
      }
    }
  }

  private createSessionAsyncIterable(
    sessionId: string
  ): AsyncIterable<InvokeModelWithBidirectionalStreamInput> {
    if (!this.isSessionActive(sessionId)) {
      console.log(
        `Cannot create async iterable: Session ${sessionId} not active`
      );
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true }),
        }),
      };
    }

    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(
        `Cannot create async iterable: Session ${sessionId} not found`
      );
    }

    let eventCount = 0;

    return {
      [Symbol.asyncIterator]: () => {
        console.log(
          `AsyncIterable iterator requested for session ${sessionId}`
        );

        return {
          next: async (): Promise<
            IteratorResult<InvokeModelWithBidirectionalStreamInput>
          > => {
            try {
              if (!session.isActive || !this.activeSessions.has(sessionId)) {
                console.log(
                  `Iterator closing for session ${sessionId}, done = true`
                );
                return { value: undefined, done: true };
              }
              if (session.queue.length === 0) {
                try {
                  await Promise.race([
                    firstValueFrom(session.queueSignal.pipe(take(1))),
                    firstValueFrom(session.closeSignal.pipe(take(1))).then(
                      () => {
                        throw new Error("Stream closed");
                      }
                    ),
                  ]);
                } catch (error) {
                  if (error instanceof Error) {
                    if (
                      error.message === "Stream closed" ||
                      !session.isActive
                    ) {
                      if (this.activeSessions.has(sessionId)) {
                        console.log(
                          `Session \${ sessionId } closed during wait`
                        );
                      }
                      return { value: undefined, done: true };
                    }
                  } else {
                    console.error(`Error on event close`, error);
                  }
                }
              }

              if (session.queue.length === 0 || !session.isActive) {
                console.log(`Queue empty or session inactive: ${sessionId} `);
                return { value: undefined, done: true };
              }

              const nextEvent = session.queue.shift();
              eventCount++;

              return {
                value: {
                  chunk: {
                    bytes: new TextEncoder().encode(JSON.stringify(nextEvent)),
                  },
                },
                done: false,
              };
            } catch (error) {
              console.error(`Error in session ${sessionId} iterator: `, error);
              session.isActive = false;
              return { value: undefined, done: true };
            }
          },

          return: async (): Promise<
            IteratorResult<InvokeModelWithBidirectionalStreamInput>
          > => {
            console.log(`Iterator return () called for session ${sessionId}`);
            session.isActive = false;
            return { value: undefined, done: true };
          },

          throw: async (
            error: any
          ): Promise<
            IteratorResult<InvokeModelWithBidirectionalStreamInput>
          > => {
            console.log(
              `Iterator throw () called for session ${sessionId} with error: `,
              error
            );
            session.isActive = false;
            throw error;
          },
        };
      },
    };
  }

  private async processToolUse(
    ws: WebSocket,
    toolName: string,
    toolUseContent: object
  ): Promise<Object> {
    const tool = toolName.toLowerCase();

    try {
      return await this.toolRegistry.execute(this, ws, tool, toolUseContent);
    } catch (error) {
      console.error(`Error executing tool ${tool}:`, error);
      throw error;
    }
  }

  private async processResponseStream(
    ws: WebSocket,
    conversation: Conversation,
    sessionId: string,
    response: any
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    try {
      for await (const event of response.body) {
        if (!session.isActive) {
          console.log(
            `Session ${sessionId} is no longer active, stopping response processing`
          );
          break;
        }
        if (event.chunk?.bytes) {
          try {
            this.updateSessionActivity(sessionId);
            const textResponse = new TextDecoder().decode(event.chunk.bytes);

            try {
              const jsonResponse = JSON.parse(textResponse);
              console.log(574)
              if (jsonResponse.event?.contentStart) {
                this.dispatchEvent(
                  sessionId,
                  "contentStart",
                  jsonResponse.event.contentStart
                );
              } else if (jsonResponse.event?.textOutput) {
                this.dispatchEvent(
                  sessionId,
                  "textOutput",
                  jsonResponse.event.textOutput
                );
              } else if (jsonResponse.event?.audioOutput) {
                console.log(589)
                this.dispatchEvent(
                  sessionId,
                  "audioOutput",
                  jsonResponse.event.audioOutput
                );
              } else if (jsonResponse.event?.toolUse) {
                this.dispatchEvent(
                  sessionId,
                  "toolUse",
                  jsonResponse.event.toolUse
                );

                session.toolUseContent = jsonResponse.event.toolUse;
                session.toolUseId = jsonResponse.event.toolUse.toolUseId;
                session.toolName = jsonResponse.event.toolUse.toolName;
              } else if (
                jsonResponse.event?.contentEnd &&
                jsonResponse.event?.contentEnd?.type === "TOOL"
              ) {
                console.log(`Processing tool use for session ${sessionId}`);
                this.dispatchEvent(sessionId, "toolEnd", {
                  toolUseContent: session.toolUseContent,
                  toolUseId: session.toolUseId,
                  toolName: session.toolName,
                });

                console.log(
                  "Calling tool with content:",
                  session.toolUseContent
                );
                const toolResult = await this.processToolUse(
                  ws,
                  session.toolName,
                  session.toolUseContent
                );

                this.sendToolResult(sessionId, session.toolUseId, toolResult);

                this.dispatchEvent(sessionId, "toolResult", {
                  toolUseId: session.toolUseId,
                  result: toolResult,
                });
              } else if (jsonResponse.event?.contentEnd) {
                this.dispatchEvent(
                  sessionId,
                  "contentEnd",
                  jsonResponse.event.contentEnd
                );
              } else {
                const eventKeys = Object.keys(jsonResponse.event || {});
                console.log(`Event keys for session ${sessionId}: `, eventKeys);
                console.log(`Handling other events`);
                if (eventKeys.length > 0) {
                  this.dispatchEvent(
                    sessionId,
                    eventKeys[0],
                    jsonResponse.event
                  );
                } else if (Object.keys(jsonResponse).length > 0) {
                  this.dispatchEvent(sessionId, "unknown", jsonResponse);
                }
              }
            } catch (e) {
              console.log(
                `Raw text response for session ${sessionId}(parse error): `,
                textResponse
              );
            }
          } catch (e) {
            console.error(
              `Error processing response chunk for session ${sessionId}: `,
              e
            );
          }
        } else if (event.modelStreamErrorException) {
          console.error(
            `Model stream error for session ${sessionId}: `,
            event.modelStreamErrorException
          );
          this.dispatchEvent(sessionId, "error", {
            type: "modelStreamErrorException",
            details: event.modelStreamErrorException,
          });
        } else if (event.internalServerException) {
          console.error(
            `Internal server error for session ${sessionId}: `,
            event.internalServerException
          );
          this.dispatchEvent(sessionId, "error", {
            type: "internalServerException",
            details: event.internalServerException,
          });
        }
      }

      console.log(
        `Response stream processing complete for session ${sessionId}`
      );
      this.dispatchEvent(sessionId, "streamComplete", {
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        `Error processing response stream for session ${sessionId}: `,
        error
      );
      this.dispatchEvent(sessionId, "error", {
        source: "responseStream",
        message: "Error processing response stream",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  addEventToSessionQueue(sessionId: string, event: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    if (event.event.audioInput) {
      if (!this.contentNames.get(sessionId)) {
        this.contentNames.set(sessionId, event.event.audioInput.contentName);
        console.log("contentNames", this.contentNames);
        console.log("promptName", event.event.audioInput.promptName);
      }
    }

    console.log(`pushing event to ${sessionId}`);
    this.updateSessionActivity(sessionId);
    // console.log(716, session == null)
    session.queue.push(event);
    session.queueSignal.next();
  }

  private setupSessionStartEvent(sessionId: string): void {
    console.log(`Setting up initial events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToSessionQueue(sessionId, {
      event: {
        sessionStart: {
          inferenceConfiguration: session.inferenceConfig,
        },
      },
    });
  }

  public setupPromptStartEvent(sessionId: string): void {
    console.log(`Setting up prompt start event for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToSessionQueue(sessionId, {
      event: {
        promptStart: {
          promptName: session.promptName,
          textOutputConfiguration: {
            mediaType: "text/plain",
          },
          audioOutputConfiguration: DefaultAudioOutputConfiguration,
          toolUseOutputConfiguration: {
            mediaType: "application/json",
          },
          toolConfiguration: {
            tools: this.toolRegistry.getToolSpecs(),
          },
        },
      },
    });
    session.isPromptStartSent = true;
  }

  public setupSystemPromptEvent(
    sessionId: string,
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = DefaultSystemPrompt
  ): void {
    console.log(`Setting up systemPrompt events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const textPromptID = randomUUID();
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: textPromptID,
          type: "TEXT",
          interactive: true,
          role: "SYSTEM",
          textInputConfiguration: textConfig,
        },
      },
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: textPromptID,
          content: systemPromptContent,
        },
      },
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: textPromptID,
        },
      },
    });
  }

  public setupStartAudioEvent(
    sessionId: string,
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): void {
    console.log(
      `Setting up startAudioContent event for session ${sessionId}...`
    );
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    console.log(`Using audio content ID: ${session.audioContentId}`);
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          type: "AUDIO",
          interactive: true,
          role: "USER",
          audioInputConfiguration: audioConfig,
        },
      },
    });
    session.isAudioContentStartSent = true;
    console.log(`Initial events setup complete for session ${sessionId}`);
  }

  public async streamAudioChunk(
    sessionId: string,
    audioData: Buffer
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive || !session.audioContentId) {
      throw new Error(`Invalid session ${sessionId} for audio streaming`);
    }
    const base64Data = audioData.toString("base64");

    // console.log("838")
    this.addEventToSessionQueue(sessionId, {
      event: {
        audioInput: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          content: base64Data,
        },
      },
    });
  }

  private async sendToolResult(
    sessionId: string,
    toolUseId: string,
    result: any
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    console.log(
      `Sending tool result for session ${sessionId}, tool use ID: ${toolUseId}`
    );
    const contentName = randomUUID();

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName,
          interactive: false,
          type: "TOOL",
          role: "TOOL",
          toolResultInputConfiguration: {
            toolUseId: toolUseId,
            type: "TEXT",
            textInputConfiguration: {
              mediaType: "text/plain",
            },
          },
        },
      },
    });

    const resultContent =
      typeof result === "string" ? result : JSON.stringify(result);
    this.addEventToSessionQueue(sessionId, {
      event: {
        toolResult: {
          promptName: session.promptName,
          contentName,
          content: resultContent,
        },
      },
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: contentName,
        },
      },
    });

    console.log(`Tool result sent for session ${sessionId}`);
  }

  public async sendContentEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isAudioContentStartSent) return;

    await this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: session.audioContentId,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  public async sendPromptEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isPromptStartSent) return;
    await this.addEventToSessionQueue(sessionId, {
      event: {
        promptEnd: {
          promptName: session.promptName,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  public async sendSessionEnd(sessionId: string): Promise<void> {
    await this.addEventToSessionQueue(sessionId, {
      event: {
        sessionEnd: {},
      },
    });
    this.closeSession(sessionId);
  }

  public registerEventHandler(
    sessionId: string,
    eventType: string,
    handler: (data: any) => void
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.responseHandlers.set(eventType, handler);
  }

  dispatchEvent(sessionId: string, eventType: string, data: any): void {
    console.log(960)
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    console.log(964, session.responseHandlers)
    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      console.log(966)
      try {
        handler(data);
      } catch (e) {
        console.error(
          `Error in ${eventType} handler for session ${sessionId}:`,
          e
        );
      }
    }

    // Also dispatch to "any" handlers
    const anyHandler = session.responseHandlers.get("any");
    if (anyHandler) {
      try {
        anyHandler({ type: eventType, data });
      } catch (e) {
        console.error(`Error in 'any' handler for session ${sessionId}:`, e);
      }
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    if (this.sessionCleanupInProgress.has(sessionId)) {
      console.log(`Session ${sessionId} is being cleaned up.`);
      return;
    }
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    console.log(`Closing session ${sessionId}`);
    this.sessionCleanupInProgress.add(sessionId);
    try {
      session.isActive = false;

      // If we are patient, we could wait for all this. Not really a point tho.
      this.sendContentEnd(sessionId);
      this.sendPromptEnd(sessionId);
      this.sendSessionEnd(sessionId);

      // This happens *sync* to force close the session.
      session.closeSignal.next();
      session.closeSignal.complete();
      this.activeSessions.delete(sessionId);
      this.sessionLastActivity.delete(sessionId);
      console.log(`Session ${sessionId} closed.`);
    } finally {
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }
}
