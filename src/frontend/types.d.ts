export interface ConversationMessage {
  id: number;
  sender: string;
  text: string;
  time: string;
}

export interface SentimentDataPoint {
  time: number;
  score: number;
}

export interface AttentionDataPoint {
  time: number;
  attention: number;
}

export interface AudioMetrics {
  clarity: number;
  volume: number;
  noise: number;
}

export interface VideoMetrics {
  quality: number;
  framerate: number;
  lighting: number;
}

export interface OverallSentiment {
  positive: number;
  neutral: number;
  negative: number;
}

export interface SentimentResult {
  sentimentData?: SentimentDataPoint[];
  overallSentiment?: OverallSentiment;
  insights?: string[];
}

export interface HistoryItem {
  role: string;
  message: string;
}
