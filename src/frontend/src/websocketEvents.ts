import AudioPlayer from "./lib/play/AudioPlayer.js";
import ChatHistoryManager from "./lib/util/ChatHistoryManager.js";

const audioPlayer = new AudioPlayer();

export class WebSocketEventManager {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.promptName = null;
    this.audioContentName = null;
    this.audioContext = new (window.AudioContext ||
      window.webkitAudioContext)();
    this.currentAudioConfig = null;
    this.isProcessing = false;
    this.seenChunks = new Set();

    // New properties for message handling
    this.lastTextOutput = null;
    this.pendingMessages = {};
    this.messageBuffer = {};

    this.chat = { history: [] };
    this.chatRef = { current: this.chat };

    // for metric calculation
    this.talkTimeMetrics = {
      userTalkTime: 0,
      agentTalkTime: 0,
      userStartTime: null,
      agentStartTime: null,
      lastUserEndTime: null,
      responseTimeTotal: 0,
      responseCount: 0,
      isUserTalking: false,
      isAgentTalking: false,
      // Add these new properties for content length-based estimation
      userContentLength: 0,
      agentContentLength: 0,
      // New flag to track if response time was measured for current turn
      responseMeasuredForCurrentTurn: false,
    };

    this.chatHistoryManager = ChatHistoryManager.getInstance(
      this.chatRef,
      (newChat) => {
        this.chat = { ...newChat };
        this.chatRef.current = this.chat;
        // Call the update transcript callback if defined
        if (this.onUpdateTranscript) {
          this.onUpdateTranscript(this.chat.history);
        }
      }
    );

    this.connect();
  }

  // Callback handlers that can be set from main.js
  onUpdateTranscript = null;
  onUpdateStatus = null;
  onAudioReceived = null;

  updateChatUI() {
    // This function is now obsolete as we're using the onUpdateTranscript callback
    // But keeping it for backward compatibility
    if (this.onUpdateTranscript) {
      this.onUpdateTranscript(this.chat.history);
    } else {
      const chatContainer = document.getElementById("transcript-container");
      if (!chatContainer) {
        console.error("Transcript container not found");
        return;
      }

      // Clear existing chat messages
      chatContainer.innerHTML = "";

      // Add all messages from history
      this.chat.history.forEach((item) => {
        if (item.endOfConversation) {
          const endDiv = document.createElement("div");
          endDiv.className = "message system";
          endDiv.textContent = "Conversation ended";
          chatContainer.appendChild(endDiv);
          return;
        }

        if (item.role) {
          const messageDiv = document.createElement("div");
          const roleLowerCase = item.role.toLowerCase();
          messageDiv.className = `message ${roleLowerCase}`;

          const roleLabel = document.createElement("div");
          roleLabel.className = "role-label";
          roleLabel.textContent = item.role;
          messageDiv.appendChild(roleLabel);

          const content = document.createElement("div");
          content.textContent = item.message || "No content";
          messageDiv.appendChild(content);

          chatContainer.appendChild(messageDiv);
        }
      });
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }

  connect() {
    if (this.socket) this.socket.close();
    this.socket = new WebSocket(this.wsUrl);
    this.setupSocketListeners();
  }

  setupSocketListeners() {
    this.socket.onopen = () => {
      console.log("WebSocket Connected");
      this.updateStatus("Connected", "connected");
      this.isProcessing = true;
      this.startSession();
      audioPlayer.start();
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (e) {
        console.error("Error parsing message:", e, "Raw data:", event.data);
      }
    };

    this.socket.onerror = (error) => {
      console.error("WebSocket Error:", error);
      this.updateStatus("Connection error", "error");
      this.isProcessing = false;
    };

    this.socket.onclose = (event) => {
      console.log("WebSocket Disconnected", event);
      this.updateStatus("Disconnected", "disconnected");
      this.isProcessing = false;
      audioPlayer.stop();
      if (this.isProcessing) {
        console.log("Attempting to reconnect...");
        setTimeout(() => this.connect(), 1000);
      }
    };
  }

  async sendEvent(event) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error(
        "WebSocket is not open. Current state:",
        this.socket?.readyState
      );
      return;
    }

    try {
      this.socket.send(JSON.stringify(event));
    } catch (error) {
      console.error("Error sending event:", error);
      this.updateStatus("Error sending message", "error");
    }
  }

  handleMessage(data) {
    if (!data.event) {
      console.error("Received message without event:", data);
      return;
    }

    const event = data.event;

    try {
      // Handle session events
      if (event.sessionStart) {
        console.log("Session start received");
      }
      // Handle prompt events
      else if (event.promptStart) {
        this.promptName = event.promptStart.promptName;
      } else if (event.audioInput) {
        const audioInput = event.audioInput;
        const content = event.audioInput.content;
        if (audioInput.role === "USER" && !this.seenChunks.has(content)) {
          this.sendAudioChunk(content);
          this.seenChunks.add(content)
        }
      } else if (event.contentStart) {
        console.log("Content start received:", event.contentStart.type);
        if (event.contentStart.type === "AUDIO") {
          if (event.contentStart.role == "USER") {
            this.startUserTalking();
          } else {
            this.currentAudioConfig =
              event.contentStart.audioOutputConfiguration;
            this.audioBuffer = [];
            this.handleAudioContentStart();
          }
        } else if (event.contentStart.type === "TEXT") {
          // Reset message buffer for new text content
          this.messageBuffer = {};
        }
      } else if (event.textOutput) {
        const role = event.textOutput.role;
        let content = event.textOutput.content;

        if (role === "ASSISTANT" && content.startsWith("Speculative: ")) {
          content = content.slice(13)
        }

        if (this.seenChunks.has(content)) return;

        this.seenChunks.add(content);

        if (!this.messageBuffer[role]) this.messageBuffer[role] = content;
      }
      // Handle audio output
      else if (event.audioOutput) {
        if (this.currentAudioConfig) {
          const audioData = this.base64ToFloat32Array(
            event.audioOutput.content
          );
          audioPlayer.playAudio(audioData);

          if (this.onAudioReceived) {
            this.onAudioReceived(audioData);
          }
        }
      } else if (event.contentEnd) {
        console.log("Content end received:", event.contentEnd);
        const contentType = event.contentEnd.type;

        if (event.contentEnd.stopReason === "INTERRUPTED") {
          console.log("Content was interrupted by user");
          audioPlayer.bargeIn();

          this.updateStatus("User interrupted", "interrupted");
        }

        if (contentType === "TEXT") {
          // Process buffered text messages
          for (const [role, message] of Object.entries(this.messageBuffer)) {
            if (message && message.trim()) {
              this.trackMessageContent(role, message);
              this.chatHistoryManager.addTextMessage({
                role: role,
                message: message,
              });
            }
          }
          this.messageBuffer = {};
        } else if (contentType === "AUDIO") {
          this.handleAudioContentEnd();
        } else if (contentType === "SILENT_AUDIO") {
          this.stopUserTalking()
        }
      } else if (event.toolUse) {
        console.log("Tool use event received:", event.toolUse.toolName);
      } else if (event.promptEnd) {
        console.log("Prompt end received");
      } else if (event.sessionEnd) {
        console.log("Session end received");
      }
    } catch (error) {
      console.error("Error processing message:", error);
      console.error("Event data:", event);
    }
  }

  handleTextOutput(data) {
    console.log("Processing text output:", data);
    if (data.message) {
      const messageData = {
        role: data.role,
        message: data.message,
      };
      this.chatHistoryManager.addTextMessage(messageData);
    }
  }

  updateStatus(message, className) {
    // Call the update status callback if defined
    if (this.onUpdateStatus) {
      this.onUpdateStatus(message, className);
    } else {
      const statusDiv = document.getElementById("status");
      if (statusDiv) {
        statusDiv.textContent = message;
        statusDiv.className = `status ${className}`;
      }
    }
  }

  cleanupToneDuplicates(text) {
    if (!text) return text;

    // List of tone markers to check for duplicates
    const toneMarkers = [
      "[empathetic]",
      "[helpful]",
      "[friendly]",
      "[professional]",
      "[joyful]",
      "[playful]",
      "[excited]",
      "[thoughtful]",
    ];

    let cleanedText = text;

    // Check for each tone marker
    for (const marker of toneMarkers) {
      // If the marker appears more than once
      if (cleanedText.indexOf(marker) !== cleanedText.lastIndexOf(marker)) {
        // Find all occurrences
        const firstIndex = cleanedText.indexOf(marker);
        const secondIndex = cleanedText.indexOf(marker, firstIndex + 1);

        // Check if there's duplicate content between the two markers
        const contentBetween = cleanedText.substring(firstIndex, secondIndex);
        const afterSecond = cleanedText.substring(secondIndex);

        if (afterSecond.includes(contentBetween)) {
          // If there's duplication, keep only up to the second marker
          cleanedText = cleanedText.substring(0, secondIndex);
        }
      }
    }

    // Check for trailing duplicate sentences
    cleanedText = this.removeTrailingDuplicates(cleanedText);

    return cleanedText;
  }

  removeTrailingDuplicates(text) {
    if (!text || text.length < 20) return text;

    // Look for trailing duplicated content
    for (
      let length = Math.min(100, Math.floor(text.length / 2));
      length >= 10;
      length--
    ) {
      const end = text.substring(text.length - length);
      const possibleDuplicatePos = text.indexOf(end);

      // If we found the same content earlier in the text and it's not just at the end
      if (
        possibleDuplicatePos >= 0 &&
        possibleDuplicatePos < text.length - length
      ) {
        // Make sure it's not just a common phrase
        if (length > 15) {
          return text.substring(0, text.length - length);
        }
      }
    }

    return text;
  }

  base64ToFloat32Array(base64String) {
    const binaryString = window.atob(base64String);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    return float32Array;
  }

  startSession() {
    console.log("Starting session...");
    const sessionStartEvent = {
      event: {
        sessionStart: {
          inferenceConfiguration: {
            maxTokens: 1024,
            topP: 0.95,
            temperature: 0.7,
          },
        },
      },
    };
    this.sendEvent(sessionStartEvent);
    this.startPrompt();
  }

  startPrompt() {
    this.promptName = crypto.randomUUID();
    // Modify to match the Bedrock prompt format
    const promptStartEvent = {
      event: {
        promptStart: {
          promptName: this.promptName,
          textOutputConfiguration: {
            mediaType: "text/plain",
          },
          audioOutputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: 24000,
            sampleSizeBits: 16,
            channelCount: 1,
            voiceId: "tiffany",
            encoding: "base64",
            audioType: "SPEECH",
          },
          toolUseOutputConfiguration: {
            mediaType: "application/json",
          },
          toolConfiguration: {
            tools: [
              {
                toolSpec: {
                  name: "lookup", // Match your backend tool name
                  description:
                    "Runs query against a knowledge base to retrieve information.",
                  inputSchema: {
                    json: JSON.stringify({
                      // Match your backend schema
                      $schema: "http://json-schema.org/draft-07/schema#",
                      type: "object",
                      properties: {
                        query: {
                          type: "string",
                          description: "the query to search",
                        },
                      },
                      required: ["query"],
                    }),
                  },
                },
              },
              {
                toolSpec: {
                  name: "userProfileSearch",
                  description:
                    "Search for a user's account and phone plan information by phone number",
                  inputSchema: {
                    json: JSON.stringify({
                      $schema: "http://json-schema.org/draft-07/schema#",
                      type: "object",
                      properties: {
                        phone_number: {
                          type: "string",
                          description: "the user's phone number",
                        },
                      },
                      required: ["phone_number"],
                    }),
                  },
                },
              },
            ],
          },
        },
      },
    };

    this.sendEvent(promptStartEvent);
    this.sendSystemPrompt();
  }

  sendSystemPrompt() {
    const systemContentName = crypto.randomUUID();
    const contentStartEvent = {
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: systemContentName,
          type: "TEXT",
          interactive: true,
          textInputConfiguration: {
            mediaType: "text/plain",
          },
        },
      },
    };
    this.sendEvent(contentStartEvent);

    const systemPrompt =
      "You're Telly, AnyTelco's customer support voice assistant. Your job is to assist customers with their problems relating to AnyTelco products and services. You must begin any conversation by asking for the user's phone number and then immediately use the useProfileSearch tool to search the user's number and retrieve their account and cell plan information. Once you have done that, ask what you can help the customer with. Do not proceed with any assistance until you have performed this profile search. After obtaining their information through the search, validate customer concerns while using your tools and the retrieved account information to aid the customer in their tasks. Keep your responses short, generally two or three sentences for chatty scenarios. ou may start each of your sentences with emotions in square brackets such as [amused], [neutral] or any other stage direction such as [joyful]. Only use a single pair of square brackets for indicating a stage command. IMPORTANT: For any specific information about AnyTelco products, services, plans, pricing, technical issues, or account details that is not provided in the account information retrieved from useProfileSearch, you MUST use the knowledge base lookup. DO NOT make up information about AnyTelco offerings or policies. Only use your general knowledge for common concepts unrelated to AnyTelco specifics. If you are not very sure about an answer, do a knowledge base lookup. ## Boundaries and Focus - Be conversational and authentic rather than following rigid scripts - Listen actively to understand the customer's specific situation - ALWAYS use the knowledge base lookups to provide accurate information about AnyTelco - DO NOT MAKE UP any information about AnyTelco products, services, or policies - Only use your own knowledge for general concepts unrelated to AnyTelco specifics - If information is not in the retrieved Account Information and not in the knowledge base, acknowledge that you need to check and offer to look it up When to Use Knowledge Base Lookups For ALL of the following scenarios: - ANY questions about AnyTelco plans, pricing, or promotions - ANY cancellation or retention conversations - ANY bundle opportunities or additional services - ANY technical issues, service questions, or troubleshooting - ANY coverage or outage information Always preface responses to these topics with a knowledge base lookup rather than generating information from your general knowledge. Use your knowledge base lookup extremely liberally.";
    const textInputEvent = {
      event: {
        textInput: {
          promptName: this.promptName,
          contentName: systemContentName,
          content: systemPrompt,
          role: "SYSTEM",
        },
      },
    };
    this.sendEvent(textInputEvent);

    const contentEndEvent = {
      event: {
        contentEnd: {
          promptName: this.promptName,
          contentName: systemContentName,
        },
      },
    };
    this.sendEvent(contentEndEvent);

    this.startAudioContent();
  }

  startAudioContent() {
    this.audioContentName = crypto.randomUUID();
    const contentStartEvent = {
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          type: "AUDIO",
          role: "USER",
          interactive: true,
          audioInputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: 16000,
            sampleSizeBits: 16,
            channelCount: 1,
            audioType: "SPEECH",
            encoding: "base64",
          },
        },
      },
    };
    this.sendEvent(contentStartEvent);
  }

  sendAudioChunk(base64AudioData) {
    if (!this.promptName || !this.audioContentName) {
      console.error(
        "Cannot send audio chunk - missing promptName or audioContentName"
      );
      return;
    }

    const audioInputEvent = {
      event: {
        audioInput: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          content: base64AudioData,
          role: "USER",
        },
      },
    };
    this.sendEvent(audioInputEvent);
  }

  endContent() {
    const contentEndEvent = {
      event: {
        contentEnd: {
          promptName: this.promptName,
          contentName: this.audioContentName,
        },
      },
    };
    this.sendEvent(contentEndEvent);
  }

  endPrompt() {
    const promptEndEvent = {
      event: {
        promptEnd: {
          promptName: this.promptName,
        },
      },
    };
    this.sendEvent(promptEndEvent);
  }

  endSession() {
    const sessionEndEvent = {
      event: {
        sessionEnd: {},
      },
    };
    this.sendEvent(sessionEndEvent);
    this.socket.close();
  }

  cleanup() {
    this.isProcessing = false;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        if (this.audioContentName && this.promptName) {
          this.endContent();
          this.endPrompt();
        }
        this.endSession();
      } catch (error) {
        console.error("Error during cleanup:", error);
      }
    }
    this.chatHistoryManager.endConversation();
  }

  trackTalkTimes(role, isStarting) {
    const now = Date.now();

    // Track user talk time
    if (role.toLowerCase() === "user") {
      if (isStarting) {
        // User started talking
        this.talkTimeMetrics.userStartTime = now;
      } else if (this.talkTimeMetrics.userStartTime) {
        // User stopped talking
        const duration = now - this.talkTimeMetrics.userStartTime;
        this.talkTimeMetrics.userTalkTime += duration;
        this.talkTimeMetrics.userStartTime = null;
        this.talkTimeMetrics.lastUserEndTime = now;
      }
    }
    // Track agent talk time
    else if (role.toLowerCase() === "assistant") {
      if (isStarting) {
        // Agent started talking
        this.talkTimeMetrics.agentStartTime = now;

        // Calculate response time if we have a previous user end time
        if (this.talkTimeMetrics.lastUserEndTime) {
          const responseTime = now - this.talkTimeMetrics.lastUserEndTime;
          this.talkTimeMetrics.responseTimeTotal += responseTime;
          this.talkTimeMetrics.responseCount++;
        }
      } else if (this.talkTimeMetrics.agentStartTime) {
        // Agent stopped talking
        const duration = now - this.talkTimeMetrics.agentStartTime;
        this.talkTimeMetrics.agentTalkTime += duration;
        this.talkTimeMetrics.agentStartTime = null;
      }
    }

    // Return current metrics
    return this.getTalkTimeMetrics();
  }

  getTalkTimeMetrics() {
    // First calculate based on actual recorded time
    const totalTalkTime =
      this.talkTimeMetrics.userTalkTime + this.talkTimeMetrics.agentTalkTime;

    // Calculate percentages based on time
    let userTalkPercent = 0;
    let agentTalkPercent = 0;

    if (totalTalkTime > 0) {
      userTalkPercent = Math.round(
        (this.talkTimeMetrics.userTalkTime / totalTalkTime) * 100
      );
      agentTalkPercent = Math.round(
        (this.talkTimeMetrics.agentTalkTime / totalTalkTime) * 100
      );
    }

    // Calculate percentages based on content length (usually more accurate for text)
    let userContentPercent = 0;
    let agentContentPercent = 0;

    const totalContentLength =
      this.talkTimeMetrics.userContentLength +
      this.talkTimeMetrics.agentContentLength;
    if (totalContentLength > 0) {
      userContentPercent = Math.round(
        (this.talkTimeMetrics.userContentLength / totalContentLength) * 100
      );
      agentContentPercent = Math.round(
        (this.talkTimeMetrics.agentContentLength / totalContentLength) * 100
      );
    }

    // Use a hybrid approach - weight content length more heavily for text-based interactions
    // Weight is 0.7 for content length, 0.3 for time-based calculation
    const userPercent = Math.round(
      userContentPercent * 0.7 + userTalkPercent * 0.3
    );
    const agentPercent = Math.round(
      agentContentPercent * 0.7 + agentTalkPercent * 0.3
    );

    // Ensure percentages add up to 100%
    let finalUserPercent = userPercent;
    let finalAgentPercent = agentPercent;

    if (userPercent + agentPercent !== 100) {
      const total = userPercent + agentPercent;
      if (total > 0) {
        finalUserPercent = Math.round((userPercent / total) * 100);
        finalAgentPercent = 100 - finalUserPercent;
      } else {
        // Default to 50/50 if no data available
        finalUserPercent = 50;
        finalAgentPercent = 50;
      }
    }

    // Calculate average response time in seconds
    let avgResponseTime = 0;
    if (this.talkTimeMetrics.responseCount > 0) {
      avgResponseTime =
        this.talkTimeMetrics.responseTimeTotal /
        this.talkTimeMetrics.responseCount /
        1000;
      avgResponseTime = Math.round(avgResponseTime * 10) / 10; // Round to 1 decimal place
    }

    return {
      userTalkPercent: finalUserPercent,
      agentTalkPercent: finalAgentPercent,
      avgResponseTime,
      // Include raw data for debugging
      raw: {
        userTime: this.talkTimeMetrics.userTalkTime,
        agentTime: this.talkTimeMetrics.agentTalkTime,
        responseTimeTotal: this.talkTimeMetrics.responseTimeTotal,
        responseCount: this.talkTimeMetrics.responseCount,
        userContentLength: this.talkTimeMetrics.userContentLength,
        agentContentLength: this.talkTimeMetrics.agentContentLength,
      },
    };
  }

  trackMessageContent(role, content) {
    if (!content) return;

    if (role.toLowerCase() === "user") {
      this.talkTimeMetrics.userContentLength += content.length;
    } else if (role.toLowerCase() === "assistant") {
      this.talkTimeMetrics.agentContentLength += content.length;
    }

    console.log(
      `Content length - ${role}: ${content.length}, Total - User: ${this.talkTimeMetrics.userContentLength}, Agent: ${this.talkTimeMetrics.agentContentLength}`
    );
  }

  startUserTalking() {
    if (!this.talkTimeMetrics.isUserTalking) {
      this.talkTimeMetrics.isUserTalking = true;
      this.talkTimeMetrics.userStartTime = Date.now();
      // Reset the flag when user starts a new turn
      this.talkTimeMetrics.responseMeasuredForCurrentTurn = false;
      console.log(
        "User started talking at:",
        this.talkTimeMetrics.userStartTime
      );
    }
  }

  stopUserTalking() {
    if (
      this.talkTimeMetrics.isUserTalking &&
      this.talkTimeMetrics.userStartTime
    ) {
      this.talkTimeMetrics.isUserTalking = false;
      const endTime = Date.now();
      const duration = endTime - this.talkTimeMetrics.userStartTime;

      // Apply a reasonable maximum to prevent over-counting silence
      const maxDuration = 15000; // 15 seconds max for typical user utterance
      const adjustedDuration = Math.min(duration, maxDuration);

      this.talkTimeMetrics.userTalkTime += adjustedDuration;
      this.talkTimeMetrics.lastUserEndTime = endTime;

      console.log(
        "User stopped talking. Duration:",
        adjustedDuration,
        "ms, Total:",
        this.talkTimeMetrics.userTalkTime,
        "ms"
      );
      this.talkTimeMetrics.userStartTime = null;
    }
  }

  handleAudioContentStart() {
    if (!this.talkTimeMetrics.isAgentTalking) {
      this.talkTimeMetrics.isAgentTalking = true;
      this.talkTimeMetrics.agentStartTime = Date.now();

      // Only calculate response time if:
      // 1. We have a previous user end time
      // 2. We haven't already measured a response for this turn
      if (
        this.talkTimeMetrics.lastUserEndTime &&
        !this.talkTimeMetrics.responseMeasuredForCurrentTurn
      ) {
        const responseTime =
          this.talkTimeMetrics.agentStartTime -
          this.talkTimeMetrics.lastUserEndTime;

        // Only count reasonable response times (>0 and <30s)
        if (responseTime > 0 && responseTime < 30000) {
          this.talkTimeMetrics.responseTimeTotal += responseTime;
          this.talkTimeMetrics.responseCount++;
          // Set the flag to indicate we've measured a response for this turn
          this.talkTimeMetrics.responseMeasuredForCurrentTurn = true;

          console.log(
            "Response time:",
            responseTime,
            "ms, Avg:",
            this.talkTimeMetrics.responseTimeTotal /
              this.talkTimeMetrics.responseCount,
            "ms"
          );
        }
      }

      console.log(
        "Agent started talking at:",
        this.talkTimeMetrics.agentStartTime
      );
    }
  }

  handleAudioContentEnd() {
    if (
      this.talkTimeMetrics.isAgentTalking &&
      this.talkTimeMetrics.agentStartTime
    ) {
      this.talkTimeMetrics.isAgentTalking = false;
      const endTime = Date.now();
      const duration = endTime - this.talkTimeMetrics.agentStartTime;
      this.talkTimeMetrics.agentTalkTime += duration;

      console.log(
        "Agent stopped talking. Duration:",
        duration,
        "ms, Total:",
        this.talkTimeMetrics.agentTalkTime,
        "ms"
      );
      this.talkTimeMetrics.agentStartTime = null;
    }
  }

  resetTalkTimeMetrics() {
    this.talkTimeMetrics = {
      userTalkTime: 0,
      agentTalkTime: 0,
      userStartTime: null,
      agentStartTime: null,
      lastUserEndTime: null,
      responseTimeTotal: 0,
      responseCount: 0,
      isUserTalking: false,
      isAgentTalking: false,
      userContentLength: 0,
      agentContentLength: 0,
      responseMeasuredForCurrentTurn: false,
    };
  }
}
