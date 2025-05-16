import { WebSocketEventManager } from "./websocketEvents";
import sentimentTracker from "./sentimentTracker";
import {
  ConversationMessage,
  SentimentDataPoint,
  AttentionDataPoint,
  AudioMetrics,
  VideoMetrics,
  OverallSentiment,
  SentimentResult,
  HistoryItem,
} from "./types";

let wsManager: WebSocketEventManager | null = null;
let sessionTime: number = 0;
let sessionTimer: number | null = null;
let isRecording: boolean = false;
let conversationData: ConversationMessage[] = [];
let currentMessageId: number = 1;
let lastHistoryLength: number = 0;

// Global chart objects
let sentimentLineChart: Chart | null = null;
let sentimentDonutChart: Chart | null = null;

// These should be .env vars
const SERVER_URL = "54.91.73.218:3000";
let microphoneIsMuted = true;

const WS_URL = `ws://${SERVER_URL}/socket`;
const GREEN = "34, 197, 94"; // green
const ORANGE = "249, 115, 22"; // orange
const YELLOW = "234, 179, 8"; // yellow
const sentimentLabels = ["positive", "neutral", "negative"];
const SILENCE_THRESHOLD = 0.01;
const SPEECH_THRESHOLD = 0.015;
const SILENCE_DURATION = 1000;
const MIN_SPEECH_SAMPLES = 5;

// Metrics data
let sentimentData: SentimentDataPoint[] = [];
let attentionData: AttentionDataPoint[] = [];
let overallSentiment: OverallSentiment = {
  positive: 33.33,
  neutral: 33.334,
  negative: 33.33,
};
let novaInsights: string[] = ["Waiting for conversation to begin"];

function toPercentString(n: number): string {
  return String(Math.round(n));
}
function getPercent(category: string): string {
  switch (category) {
    case "positive":
      return toPercentString(overallSentiment.positive);
    case "neutral":
      return toPercentString(overallSentiment.neutral);
    case "negative":
      return toPercentString(overallSentiment.negative);
    default:
      return "";
  }
}

function initializeCharts(): void {
  const sentimentCtx = document
    .getElementById("sentiment-chart")
    ?.getContext("2d");

  if (sentimentCtx) {
    sentimentLineChart = new Chart(sentimentCtx, {
      type: "line",
      data: {
        labels: Array(20)
          .fill("")
          .map((_, i) => i.toString()),
        datasets: [
          {
            label: "Sentiment",
            data: Array(20).fill(50), // Start with neutral values (50)
            borderColor: `rgb(${YELLOW})`, // Default color (neutral)
            backgroundColor: `rgba(${YELLOW}, 0.1)`,
            fill: true,
            tension: 0.4,
            pointRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
          },
        },
        plugins: {
          legend: {
            position: "top",
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                const value = context.raw as number;
                let sentiment = "neutral";
                if (value >= 66) sentiment = "positive";
                else if (value <= 33) sentiment = "negative";
                return `Sentiment: ${sentiment} (${value})`;
              },
            },
          },
        },
      },
    });
  }

  // Initialize the sentiment donut chart
  const donutCtx = document.getElementById("sentiment-donut")?.getContext("2d");
  if (donutCtx) {
    sentimentDonutChart = new Chart(donutCtx, {
      type: "doughnut",
      data: {
        labels: sentimentLabels,
        datasets: [
          {
            data: [33, 33, 34],
            backgroundColor: [
              `rgb(${GREEN})`,
              `rgb(${YELLOW})`,
              `rgb(${ORANGE})`,
            ],
            hoverOffset: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "right",
          },
        },
      },
    });
  }
}

function initializeDashboard(): void {
  sentimentData = Array(20)
    .fill(null)
    .map((_, index) => ({
      time: index,
      score: 50, // Default neutral score
    }));
  attentionData = Array(20)
    .fill(null)
    .map((_, index) => ({
      time: index,
      attention: Math.random() * 0.5 + 0.5,
    }));

  initializeCharts();
  updateDashboard();

  document
    .getElementById("start-button")
    ?.addEventListener("click", startStreaming);
  document
    .getElementById("stop-button")
    ?.addEventListener("click", stopStreaming);
}

async function updateTranscript(history: HistoryItem[] | null): Promise<void> {
  if (!history || history.length === 0) return;
  conversationData = [];

  // Just process the current state of the history directly
  for (let i = 0; i < history.length; i++) {
    const historyItem = history[i];

    if (!historyItem.role || !historyItem.message) continue;
    if (historyItem.role.toLowerCase() === "system") continue;

    let sender: string;
    if (historyItem.role.toLowerCase() === "user") {
      sender = "user";
    } else if (historyItem.role.toLowerCase() === "assistant") {
      sender = "agent";
    } else {
      continue; // Skip if not user or assistant
    }

    // Calculate a unique timestamp for each message based on its position
    // This ensures older messages have earlier timestamps
    const messagePosition = i / history.length; // 0 to 1 based on position
    const estimatedSeconds = Math.floor(sessionTime * messagePosition);
    const mins = Math.floor(estimatedSeconds / 60);
    const secs = estimatedSeconds % 60;
    const uniqueTime = `${mins}:${secs < 10 ? "0" + secs : secs}`;

    conversationData.push({
      id: i + 1,
      sender: sender,
      text: historyItem.message,
      time: uniqueTime,
    });
  }

  lastHistoryLength = history.length;
  updateTranscriptUI();

  // Process history with sentiment tracker
  // This is async but we don't need to wait for the result
  // since updateDashboard will be called periodically
  sentimentTracker
    .processHistory(history)
    .then((result: SentimentResult | null) => {
      if (result) updateSentimentWithResult(result);
    });
}

function updateTranscriptUI(): void {
  const transcriptContainer = document.getElementById("transcript-container");
  if (!transcriptContainer) return;

  transcriptContainer.innerHTML = "";

  let userMessageCount = 0;
  const totalUserMessages = conversationData.filter(
    (msg) => msg.sender === "user"
  ).length;

  conversationData.forEach((message) => {
    const messageDiv = document.createElement("div");
    messageDiv.className = `flex ${
      message.sender === "user" ? "justify-end" : "justify-start"
    }`;

    const innerDiv = document.createElement("div");
    innerDiv.className = `max-w-xs p-3 rounded-lg ${
      message.sender === "user"
        ? "bg-blue-500 text-white rounded-br-none"
        : "bg-gray-300 text-black rounded-bl-none"
    }`;

    let cleanText = message.text;
    const handleTrailingDuplicates = (text: string): string => {
      for (
        let endLength = Math.floor(text.length / 2);
        endLength > 4;
        endLength--
      ) {
        const end = text.substring(text.length - endLength);
        const beforeEnd = text.substring(0, text.length - endLength);
        if (beforeEnd.includes(end)) {
          return beforeEnd;
        }
      }
      return text;
    };

    const handleCompleteDuplicates = (text: string): string => {
      const markers = [
        "[playful]",
        "[joyful]",
        "[excited]",
        "[thoughtful]",
        "[friendly]",
      ];
      for (const marker of markers) {
        if (
          text.includes(marker) &&
          text.indexOf(marker) !== text.lastIndexOf(marker)
        ) {
          return text.substring(0, text.lastIndexOf(marker));
        }
      }
      return text;
    };

    cleanText = handleCompleteDuplicates(cleanText);
    cleanText = handleTrailingDuplicates(cleanText);

    // Create text content
    const textDiv = document.createElement("div");
    textDiv.className = "text-sm";
    textDiv.textContent = cleanText;

    const footerDiv = document.createElement("div");
    footerDiv.className =
      "flex justify-between items-center mt-1 text-xs opacity-70";

    const timeSpan = document.createElement("span");
    timeSpan.textContent = message.time; // This should be the message's own timestamp
    footerDiv.appendChild(timeSpan);

    if (message.sender === "user") {
      userMessageCount++;
      let messageSentiment = 50; // Default neutral

      if (sentimentData?.length > 0) {
        // Map the user message index to a sentiment data index
        // Calculate which sentiment data point to use based on the user message position
        const sentimentIndex = Math.min(
          Math.floor(
            (userMessageCount / totalUserMessages) * sentimentData.length
          ) - 1,
          sentimentData.length - 1
        );

        // Use sentiment data at or near this index
        const dataIndex = Math.max(0, sentimentIndex);
        messageSentiment = sentimentData[dataIndex].score;
      }

      const sentimentDot = document.createElement("div");

      // Determine color based on sentiment score
      let dotColor;
      if (messageSentiment >= 66) {
        dotColor = "bg-green-500";
      } else if (messageSentiment >= 33) {
        dotColor = "bg-yellow-500";
      } else {
        dotColor = "bg-orange-500";
      }

      sentimentDot.className = `w-3 h-3 rounded-full ${dotColor} ml-2`;
      sentimentDot.title = `Sentiment: ${messageSentiment}`;
      footerDiv.appendChild(sentimentDot);
    }

    innerDiv.appendChild(textDiv);
    innerDiv.appendChild(footerDiv);
    messageDiv.appendChild(innerDiv);
    transcriptContainer.appendChild(messageDiv);
  });

  // Scroll to bottom
  transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

function updateSentimentWithResult(result: SentimentResult): void {
  if (!result) return;
  if (result.sentimentData?.length > 0) {
    sentimentData = result.sentimentData.map((item) => ({
      time: item.time - result.sentimentData![0].time,
      score: item.score,
    }));
  }
  if (result.overallSentiment) overallSentiment = result.overallSentiment;
  if (result.insights?.length > 0) novaInsights = result.insights;
  updateDashboard();
}

function updateStatus(message: string, status: string): void {
  const statusElement = document.getElementById("connection-status");
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.className = `status ${status}`;
  }
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? "0" + secs : secs}`;
}

function updateDashboard(): void {
  function updateTimerDisplay(): void {
    const timerElement = document.getElementById("session-time");
    if (timerElement) timerElement.textContent = formatTime(sessionTime);
  }

  function updateSentimentChart(): void {
    if (!sentimentLineChart) return;

    // Get the last 20 data points or fill with initial values if fewer
    const dataPoints = sentimentData.slice(-20);
    while (dataPoints.length < 20) {
      dataPoints.unshift({
        time: 0,
        score: 50,
      });
    }

    const scores = dataPoints.map((d) => d.score);
    sentimentLineChart.data.labels = dataPoints.map((d) => d.time.toString());
    const latestScore = scores[scores.length - 1] || 50;

    const dataset = sentimentLineChart.data.datasets[0];
    if (dataset) {
      dataset.data = scores;
      const [color, alpha] =
        latestScore >= 66
          ? [GREEN, 0.1]
          : latestScore >= 33
            ? [YELLOW, 0.1]
            : [ORANGE, 0.1];
      dataset.borderColor = `rgb(${color})`;
      dataset.backgroundColor = `rgba(${color}, ${alpha})`;
    }

    sentimentLineChart.update();
  }

  function updateSentimentDonut(): void {
    sentimentLabels.forEach((sentiment) => {
      const element = document.getElementById(`${sentiment}-percent`);
      if (element) element.textContent = getPercent(sentiment);
    });

    if (sentimentDonutChart?.data.datasets[0]) {
      sentimentDonutChart.data.datasets[0].data = [
        overallSentiment.positive,
        overallSentiment.neutral,
        overallSentiment.negative,
      ];
      sentimentDonutChart.update();
    }

    const dominantTone = document.getElementById("dominant-tone");
    if (dominantTone) {
      const tones = {
        positive: overallSentiment.positive,
        neutral: overallSentiment.neutral,
        negative: overallSentiment.negative,
      };
      dominantTone.textContent = Object.entries(tones).reduce(
        (max, [tone, value]) => (value > tones[max] ? tone : max),
        "negative"
      );
    }
  }

  function updateInsightsUI(): void {
    const insightsContainer = document.getElementById("insights-container");
    if (insightsContainer) {
      insightsContainer.innerHTML = "";
      novaInsights.forEach((insight) => {
        const insightDiv = document.createElement("div");
        insightDiv.className =
          "p-2 bg-amber-50 rounded border-l-4 border-amber-400 text-sm";
        insightDiv.textContent = insight;
        insightsContainer.appendChild(insightDiv);
      });
    }
  }

  updateTimerDisplay();
  updateSentimentChart();
  updateSentimentDonut();
  updateInsightsUI();
  updateTranscriptUI();
}

async function startStreaming(): Promise<void> {
  const startButton = document.getElementById(
    "start-button"
  ) as HTMLButtonElement | null;
  const stopButton = document.getElementById(
    "stop-button"
  ) as HTMLButtonElement | null;
  const sessionIdInput = document.getElementById(
    "session-id"
  ) as HTMLInputElement | null;

  if (startButton) startButton.disabled = true;
  if (stopButton) stopButton.disabled = false;
  isRecording = true;
  updateRecordingIndicator(true);

  // Get the session ID if provided
  const sessionId = sessionIdInput?.value.trim() || "";
  const isJoiningExistingSession = sessionId !== "";

  // Update the WebSocket URL to include the channel parameter if joining an existing session
  const wsUrl = isJoiningExistingSession
    ? `${WS_URL}?channel=${encodeURIComponent(sessionId)}`
    : WS_URL;

  wsManager = new WebSocketEventManager(wsUrl);
  wsManager.onUpdateTranscript = updateTranscript;
  wsManager.onUpdateStatus = updateStatus;
  wsManager.onAudioReceived = updateSpeechAnalytics;

  // Update the status to show whether we're creating or joining a session
  updateStatus(
    isJoiningExistingSession
      ? `Connecting to session: ${sessionId}`
      : "Creating new session...",
    "connecting"
  );

  if (wsManager) wsManager.resetTalkTimeMetrics();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1, // mono
        sampleRate: 16000, // kHz
        sampleSize: 16, // bit
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const audioContext = new AudioContext({
      sampleRate: 16000,
      latencyHint: "interactive",
    });

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(1024, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    // Variables for user speech detection
    let userIsSpeaking = false;
    let silenceTimer: number | null = null;
    let speakingStarted = false;

    let speechSampleCount = 0;

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);

      const pcmData = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      const audioLevel = Math.max(...Array.from(inputData).map(Math.abs));

      if (audioLevel > SPEECH_THRESHOLD) {
        speechSampleCount++;

        // If we have enough speech samples, confirm the user is speaking
        if (speechSampleCount >= MIN_SPEECH_SAMPLES && !userIsSpeaking) {
          userIsSpeaking = true;
          if (wsManager && !speakingStarted) {
            console.log("User speech detected, level:", audioLevel);
            wsManager.startUserTalking();
            speakingStarted = true;
          }
        }

        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
      } else if (audioLevel < SILENCE_THRESHOLD && userIsSpeaking) {
        speechSampleCount = 0;

        if (!silenceTimer) {
          silenceTimer = window.setTimeout(() => {
            userIsSpeaking = false;
            speakingStarted = false;
            if (wsManager) {
              console.log("User silence detected");
              wsManager.stopUserTalking();
            }
            silenceTimer = null;
          }, SILENCE_DURATION);
        }
      } else {
        speechSampleCount = 0;
      }

      // Convert to base64
      // TODO: We really shouldn't do this.
      const base64data = btoa(
        String.fromCharCode.apply(null, new Uint8Array(pcmData.buffer))
      );
      if (wsManager && !microphoneIsMuted) wsManager.sendAudioChunk(base64data);
    };

    (window as any).audioCleanup = () => {
      if (wsManager && userIsSpeaking) wsManager.stopUserTalking();
      if (silenceTimer) clearTimeout(silenceTimer);
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
    };

    // Start dashboard timer
    startDashboardUpdates();
  } catch (error: any) {
    console.error("Error accessing microphone:", error);
    updateStatus(`Error: ${error.message}`, "error");
  }
}

function stopStreaming(): void {
  if ((window as any).audioCleanup) (window as any).audioCleanup();
  if (wsManager) wsManager.cleanup();
  if (sessionTimer) clearInterval(sessionTimer);

  // Update UI
  const startButton = document.getElementById(
    "start-button"
  ) as HTMLButtonElement | null;
  const stopButton = document.getElementById(
    "stop-button"
  ) as HTMLButtonElement | null;

  if (startButton) startButton.disabled = false;
  if (stopButton) stopButton.disabled = true;

  isRecording = false;
  updateRecordingIndicator(false);
  updateStatus("Disconnected", "disconnected");
}

function startDashboardUpdates(): void {
  sessionTime = 0;
  sessionTimer = window.setInterval(() => {
    sessionTime++;
    updateSentimentWithResult(sentimentTracker.getCurrentData());
    updateSpeechAnalytics();
    updateDashboard();
  }, 1000);
}

function updateSpeechAnalytics(): void {
  if (!wsManager) return;
  const metrics = wsManager.getTalkTimeMetrics();
  [
    ["agent-talk-time", metrics.agentTalkPercent],
    ["user-talk-time", metrics.userTalkPercent],
    ["response-time", metrics.avgResponseTime],
  ].forEach(([id, value]) => {
    const element: any = document.getElementById(id);
    if (element) element.textContent = value;
  });
}

function updateRecordingIndicator(isActive: boolean): void {
  const indicator = document.getElementById("recording-indicator");
  const status = document.getElementById("recording-status");
  const dataStatus = document.getElementById("data-status");

  if (indicator && status && dataStatus) {
    if (isActive) {
      indicator.className = "w-2 h-2 rounded-full bg-red-500 animate-pulse";
      status.textContent = "Recording";
      dataStatus.textContent = "Data refreshing: Real-time";
    } else {
      indicator.className = "w-2 h-2 rounded-full bg-gray-400";
      status.textContent = "Paused";
      dataStatus.textContent = "Data refreshing: Paused";
    }
  }
}

function enhanceWebSocketEventManager(): void {
  const originalWsManagerClass = WebSocketEventManager;

  // Override with extended functionality
  window.WebSocketEventManager = class ExtendedWebSocketEventManager extends (
    originalWsManagerClass
  ) {
    private channelId: string = "";

    constructor(url: string) {
      super(url);

      // Extract channel ID from URL if present
      const match = url.match(/channel=([^&]*)/);
      if (match && match[1]) {
        this.channelId = decodeURIComponent(match[1]);
        console.log(`Connecting to existing channel: ${this.channelId}`);
      }
    }

    // Override the onMessage handler to handle session information
    protected onMessage(event: MessageEvent): void {
      try {
        const data = JSON.parse(event.data);

        // Handle session ready event
        if (data.event === "sessionReady") {
          // If we get a session ID from the server and didn't have one, save it
          if (data.channelId && !this.channelId) {
            this.channelId = data.channelId;

            // Update the session ID input field with the new ID
            const sessionIdInput = document.getElementById(
              "session-id"
            ) as HTMLInputElement | null;
            if (sessionIdInput) {
              sessionIdInput.value = this.channelId;
            }

            console.log(`Connected to new channel: ${this.channelId}`);
          }

          updateStatus(
            this.channelId
              ? `Connected to session: ${this.channelId}`
              : "Connected to new session",
            "connected"
          );
        }

        // Call the original onMessage handler
        super.onMessage(event);
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
      }
    }
  };
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
  const chartScript = document.createElement("script");
  chartScript.src = "https://cdn.jsdelivr.net/npm/chart.js";
  chartScript.onload = () => {
    enhanceWebSocketEventManager();
    createHtmlStructure();
    initializeDashboard();
  };
  document.head.appendChild(chartScript);
});

function createHtmlStructure(): void {
  document.body.innerHTML = `
        <div class="flex flex-col w-full h-screen bg-gray-50 gap-4">
          <!-- Apply padding to entire dashboard container -->
          <div class="px-8 py-4 flex flex-col w-full h-full gap-4">
            <!-- Header -->
            <div class="flex justify-between items-center bg-white p-4 rounded-lg shadow flex-shrink-0">
              <div class="flex items-center gap-2">
                <div class="text-blue-500">⚡</div>
                <h1 class="text-xl font-bold">
                  Amazon Nova Real-time Analytics Dashboard
                </h1>
              </div>
              <div class="flex items-center gap-4">
                <!-- Add session ID input field -->
                <div class="flex items-center gap-2">
                  <label for="session-id" class="text-sm">Session ID:</label>
                  <input
                    id="session-id"
                    type="text"
                    placeholder="Leave empty for new session"
                    class="border rounded px-2 py-1 text-sm w-48"
                  />
                </div>
                <div class="flex items-center gap-2">
                  <div>🕐</div>
                  <span id="session-time" class="font-mono">0:00</span>
                </div>
                <div id="connection-status" class="status disconnected">Disconnected</div>
                <button
                  id="start-button"
                  class="flex items-center gap-2 px-3 py-1 rounded-md bg-green-100 text-green-700"
                >
                  Start Session
                </button>
                <button
                  id="stop-button"
                  class="flex items-center gap-2 px-3 py-1 rounded-md bg-red-100 text-red-700"
                  disabled
                >
                  Stop Session
                </button>
              </div>
            </div>

            <!-- Main content -->
            <div class="flex gap-4 flex-grow overflow-hidden">
              <!-- Left column - Metrics -->
              <div class="flex flex-col flex-1 gap-4 overflow-y-auto">
                <!-- Sentiment charts row -->
                <div class="grid grid-cols-2 gap-4">
                  <div class="bg-white p-4 rounded-lg shadow">
                    <h2 class="text-md font-semibold mb-2">
                      Real-time Sentiment Analysis
                    </h2>
                    <div style="height: 200px;">
                      <canvas id="sentiment-chart"></canvas>
                    </div>
                  </div>

                  <!-- Overall sentiment donut chart -->
                  <div class="bg-white p-4 rounded-lg shadow">
                    <h2 class="text-md font-semibold mb-2">
                      Overall Sentiment Distribution
                    </h2>
                    <div class="flex items-center">
                      <div style="width: 50%; height: 180px;">
                        <canvas id="sentiment-donut"></canvas>
                      </div>
                      <div class="w-1/2">
                        <div class="mb-4 flex items-center gap-2">
                          <div class="text-green-500">📈 </div>
                          <span class="font-semibold">Dominant Tone:</span>
                          <span id="dominant-tone" class="text-sm">neutral</span>
                        </div>
                        <div class="space-y-2">
                          <div class="flex items-center gap-2">
                            <div class="w-3 h-3 rounded-full bg-green-500"></div>
                            <span>
                              Positive: <span id="positive-percent">33</span>%
                            </span>
                          </div>
                          <div class="flex items-center gap-2">
                            <div class="w-3 h-3 rounded-full bg-yellow-500"></div>
                            <span>
                              Neutral: <span id="neutral-percent">33</span>%
                            </span>
                          </div>
                          <div class="flex items-center gap-2">
                            <div class="w-3 h-3 rounded-full bg-orange-500"></div>
                            <span>
                              Negative: <span id="negative-percent">34</span>%
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Nova Insights -->
                <div class="bg-white p-4 rounded-lg shadow">
                  <div class="flex items-center gap-2 mb-3">
                    <div class="text-amber-500">⚠️</div>
                    <h2 class="text-md font-semibold">Nova AI Insights</h2>
                  </div>
                  <div id="insights-container" class="space-y-2">
                    <div class="p-2 bg-amber-50 rounded border-l-4 border-amber-400 text-sm">
                      Waiting for conversation to begin
                    </div>
                  </div>
                </div>
              </div>

              <!-- Right column - Transcript with fixed height -->
              <div class="w-1/3 bg-white rounded-lg shadow p-4 flex flex-col">
                <div class="flex items-center justify-between mb-3 flex-shrink-0">
                  <div class="flex items-center gap-2">
                    <div class="text-blue-500">🎤</div>
                    <h2 class="text-md font-semibold">Live Transcript</h2>
                  </div>
                  <div class="text-xs text-gray-500">
                    <div class="flex items-center gap-1">
                      <div
                        id="recording-indicator"
                        class="w-2 h-2 rounded-full bg-gray-400"
                      ></div>
                      <span id="recording-status">Ready</span>
                    </div>
                  </div>
                </div>

                <div id="transcript-container" class="overflow-y-auto flex-grow bg-gray-100 rounded p-3 space-y-3">
                  <!-- Transcript messages will be inserted here -->
                </div>

                <!-- Speech analytics summary with guaranteed display -->
                <div class="mt-4 border-t pt-3 flex-shrink-0">
                  <h3 class="text-sm font-semibold mb-2">Speech Analytics</h3>
                  <div class="grid grid-cols-3 gap-2 text-sm">
                    <div class="flex items-center gap-1">
                      <div class="w-2 h-2 rounded-full bg-green-500"></div>
                      <span>
                        Agent Talk Time: <span id="agent-talk-time">0</span>%
                      </span>
                    </div>
                    <div class="flex items-center gap-1">
                      <div class="w-2 h-2 rounded-full bg-yellow-500"></div>
                      <span>
                        User Talk Time: <span id="user-talk-time">0</span>%
                      </span>
                    </div>
                    <div class="flex items-center gap-1">
                      <div class="w-2 h-2 rounded-full bg-blue-500"></div>
                      <span>
                        Avg Response Time: <span id="response-time">0</span>s
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Footer - guaranteed to stay at bottom -->
            <div class="flex justify-between items-center bg-white p-3 rounded-lg shadow text-xs text-gray-500 flex-shrink-0 mt-auto">
              <div>Amazon Nova Analytics v1.3.5</div>
              <div>Powered by Amazon Nova Speech and Text AI Models</div>
              <div class="flex items-center gap-2">
                <span id="data-status">Data refreshing: Ready</span>
              </div>
            </div>
          </div>
        </div>
      `;

  /* Add styles */
  const styleElement = document.createElement("style");
  styleElement.textContent = `
      body {
        font-family: sans-serif;
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100vh;
        overflow: hidden;
      }
      .status.connecting {
        background-color: #fef3c7;
        color: #92400e;
      }
      .h-screen {
        height: 100vh;
      }
      .status {
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
      }
      .status.connected {
        background-color: #dcfce7;
        color: #166534;
      }
      .status.disconnected {
        background-color: #f3f4f6;
        color: #6b7280;
      }
      .status.error {
        background-color: #fee2e2;
        color: #b91c1c;
      }
      /* Tailwind-like utility classes */
      .flex { display: flex; }
      .flex-col { flex-direction: column; }
      .flex-1 { flex: 1 1 0%; }
      .flex-shrink-0 { flex-shrink: 0; }
      .flex-grow { flex-grow: 1; }
      .mt-auto { margin-top: auto; }
      .items-center { align-items: center; }
      .justify-between { justify-content: space-between; }
      .justify-end { justify-content: flex-end; }
      .justify-start { justify-content: flex-start; }
      .gap-1 { gap: 4px; }
      .gap-2 { gap: 8px; }
      .gap-3 { gap: 12px; }
      .gap-4 { gap: 16px; }
      .w-full { width: 100%; }
      .w-1/2 { width: 50%; }
      .w-1/3 { width: 33.333333%; }
      .w-2/3 { width: 66.666667%; }
      .w-2 { width: 8px; }
      .w-3 { width: 12px; }
      .h-full { height: 100%; }
      .h-2.5 { height: 10px; }
      .h-2 { height: 8px; }
      .h-3 { height: 12px; }
      .rounded-lg { border-radius: 8px; }
      .rounded-full { border-radius: 9999px; }
      .rounded { border-radius: 4px; }
      .rounded-br-none { border-bottom-right-radius: 0; }
      .rounded-bl-none { border-bottom-left-radius: 0; }
      .bg-white { background-color: white; }
      .bg-gray-50 { background-color: #f9fafb; }
      .bg-gray-100 { background-color: #f3f4f6; }
      .bg-gray-200 { background-color: #e5e7eb; }
      .bg-gray-300 { background-color: #d1d5db; }
      .bg-gray-400 { background-color: #9ca3af; }
      .bg-gray-500 { background-color: #6b7280; }
      .bg-blue-500 { background-color: #3b82f6; }
      .bg-blue-600 { background-color: #2563eb; }
      .bg-blue-100 { background-color: #dbeafe; }
      .bg-green-500 { background-color: #22c55e; }
      .bg-green-100 { background-color: #dcfce7; }
      .bg-red-100 { background-color: #fee2e2; }
      .bg-red-500 { background-color: #ef4444; }
      .bg-red-700 { background-color: #b91c1c; }
      .bg-yellow-500 { background-color: #eab308; }
      .bg-amber-50 { background-color: #fffbeb; }
      .bg-amber-400 { border-color: #fbbf24; }
      .bg-amber-500 { background-color: #f59e0b; }
      .bg-purple-500 { background-color: #a855f7; }
      .bg-purple-600 { background-color: #9333ea; }
      .bg-indigo-500 { background-color: #6366f1; }
      .bg-orange-500 { background-color: #f97316; }
      .text-white { color: white; }
      .text-black { color: black; }
      .text-gray-500 { color: #6b7280; }
      .text-green-500 { color: #22c55e; }
      .text-green-700 { color: #15803d; }
      .text-blue-500 { color: #3b82f6; }
      .text-blue-700 { color: #1d4ed8; }
      .text-red-700 { color: #b91c1c; }
      .text-purple-500 { color: #a855f7; }
      .text-amber-500 { color: #f59e0b; }
      .p-2 { padding: 8px; }
      .p-3 { padding: 12px; }
      .p-4 { padding: 16px; }
      .pt-3 { padding-top: 12px; }
      .px-3 { padding-left: 12px; padding-right: 12px; }
      .py-1 { padding-top: 4px; padding-bottom: 4px; }
      .text-xs { font-size: 12px; }
      .text-sm { font-size: 14px; }
      .text-md { font-size: 16px; }
      .text-xl { font-size: 20px; }
      .font-mono { font-family: monospace; }
      .font-semibold { font-weight: 600; }
      .font-bold { font-weight: 700; }
      .shadow { box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06); }
      .border-t { border-top: 1px solid #e5e7eb; }
      .border-l-4 { border-left-width: 4px; }
      .border-amber-400 { border-color: #fbbf24; }
      .space-y-2 > * + * { margin-top: 8px; }
      .space-y-3 > * + * { margin-top: 12px; }
      .mt-1 { margin-top: 4px; }
      .mt-4 { margin-top: 16px; }
      .mb-1 { margin-bottom: 4px; }
      .mb-2 { margin-bottom: 8px; }
      .mb-3 { margin-bottom: 12px; }
      .mb-4 { margin-bottom: 16px; }
      .grid { display: grid; }
      .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .overflow-y-auto { overflow-y: auto; }
      .overflow-hidden { overflow: hidden; }
      .max-w-xs { max-width: 20rem; }
      .text-right { text-align: right; }
      .opacity-70 { opacity: 0.7; }
      .animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
      .animate-bounce { animation: bounce 1s infinite; }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .5; }
      }
      @keyframes bounce {
        0%, 100% { transform: translateY(-25%); animation-timing-function: cubic-bezier(0.8, 0, 1, 1); }
        50% { transform: translateY(0); animation-timing-function: cubic-bezier(0, 0, 0.2, 1); }
      }
    `;
  document.head.appendChild(styleElement);

  // Ensure audio context is resumed after user interaction
  document.addEventListener(
    "click",
    () => {
      if (
        wsManager &&
        wsManager.audioContext &&
        wsManager.audioContext.state === "suspended"
      ) {
        wsManager.audioContext.resume();
      }
    },
    { once: true }
  );
}
