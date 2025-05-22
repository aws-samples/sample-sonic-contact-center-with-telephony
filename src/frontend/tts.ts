import { SynthesizeSpeechCommand, PollyClient } from "@aws-sdk/client-polly";
import * as fs from "fs";
import config from "./config";

const pollyClient = new PollyClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
    sessionToken: config.aws.sessionToken, // Optional, include if you're using temporary credentials
  },
});

export const synthesizeSpeech = async (
  text: string
): Promise<ArrayBufferLike | null> => {
  try {
    const params = {
      OutputFormat: "mp3",
      Text: text,
      TextType: "text",
      VoiceId: "Amy",
    };
    //@ts-ignore
    const data = await pollyClient.send(new SynthesizeSpeechCommand(params));
    if (!data.AudioStream) return null;
    const chunks: Buffer[] = [];
    const audioBytes = await data.AudioStream.transformToByteArray();
    return audioBytes
    // return btoa(String.fromCharCode.apply(null, audioBytes));
  } catch (err) {
    console.error("Error synthesizing speech:", err);
  }
};
