import { AudioType, AudioMediaType, TextMediaType } from "./types";

export const DefaultInferenceConfiguration = {
  maxTokens: 1024,
  topP: 0.9,
  temperature: 0.7,
};

export const DefaultAudioInputConfiguration = {
  audioType: "SPEECH" as AudioType,
  encoding: "base64",
  mediaType: "audio/lpcm" as AudioMediaType,
  sampleRateHertz: 16000,
  sampleSizeBits: 16,
  channelCount: 1,
};

export const DefaultTextConfiguration = {
  mediaType: "text/plain" as TextMediaType,
};

export const DefaultSystemPrompt =
  "You are a friend. The user and you will engage in a spoken " +
  "dialog exchanging the transcripts of a natural real-time conversation. Keep your responses short, " +
  "generally two or three sentences for chatty scenarios.";

export const DefaultAudioOutputConfiguration = {
  ...DefaultAudioInputConfiguration,
  sampleRateHertz: 16000, // TODO: You may need to adjust this for your voice to sound normal
  voiceId: "tiffany",
};
