import { analyzeSentiment, generateInsight } from "./bedrockSentimentAnalyzer";

class SentimentTracker {
  overallSentiment;
  sentimentData;
  insights;
  lastHistoryLength;

  constructor() {
    this.sentimentData = [];
    this.overallSentiment = {
      positive: 0,
      neutral: 0,
      negative: 0,
    };
    this.insights = ["Waiting for conversation to begin"];
    this.lastHistoryLength = 0;
  }

  async processHistory(history): Promise<void> {
    if (!history || history.length <= this.lastHistoryLength) return;

    console.log("Processing new messages in history");

    let latestUserMessage = null;

    for (let i = this.lastHistoryLength; i < history.length; i++) {
      const historyItem = history[i];
      if (!historyItem.role || historyItem.role.toLowerCase() !== "user") {
        continue;
      }
      latestUserMessage = historyItem.message;
    }

    this.lastHistoryLength = history.length;
    if (latestUserMessage) {
      await this.analyzeMessage(latestUserMessage, history);
    }
  }

  async analyzeMessage(message, history) {
    try {
      // Get sentiment score for the message
      const sentimentScore = await analyzeSentiment(message);
      console.log("Sentiment score:", sentimentScore);

      // Add to sentiment data history with timestamp
      const timestamp = Math.floor(Date.now() / 1000);
      this.sentimentData.push({
        time: timestamp,
        score: sentimentScore,
      });

      // If too many data points, remove oldest
      if (this.sentimentData.length > 20) this.sentimentData.shift();

      if (sentimentScore >= 66) {
        this.overallSentiment.positive++;
      } else if (sentimentScore >= 33) {
        this.overallSentiment.neutral++;
      } else {
        this.overallSentiment.negative++;
      }

      // Convert history to format expected by the insight generator
      const formattedHistory = history.map((item) => ({
        sender: item.role?.toLowerCase() === "user" ? "user" : "agent",
        text: item.message,
      }));

      const insight = await generateInsight(formattedHistory);
      if (insight && insight.trim() !== "") {
        this.insights.unshift(insight);

        // Keep only the 5 most recent insights
        if (this.insights.length > 5) this.insights.pop();
      }

      return {
        sentimentData: this.sentimentData,
        overallSentiment: this.calculatePercentages(),
        insights: this.insights,
      };
    } catch (error) {
      console.error("Error analyzing message:", error);
      return null;
    }
  }

  calculatePercentages() {
    const total =
      this.overallSentiment.positive +
      this.overallSentiment.neutral +
      this.overallSentiment.negative;

    if (total === 0) {
      return { positive: 33, neutral: 33, negative: 34 };
    }

    return {
      positive: Math.round((this.overallSentiment.positive / total) * 100),
      neutral: Math.round((this.overallSentiment.neutral / total) * 100),
      negative: Math.round((this.overallSentiment.negative / total) * 100),
    };
  }

  getCurrentData() {
    return {
      sentimentData: this.sentimentData,
      overallSentiment: this.calculatePercentages(),
      insights: this.insights,
    };
  }
}

const sentimentTracker = new SentimentTracker();

export default sentimentTracker;
