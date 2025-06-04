import { SynthesizeSpeechCommand, PollyClient } from "@aws-sdk/client-polly";
import config from "./config";

const pollyClient = new PollyClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
    sessionToken: config.aws.sessionToken,
  },
});

export const synthesizeSpeech = async (
  text: string
): Promise<any | undefined> => {
  try {
    const wrappedSsmlText =  "<speak>" + text + `<break time="2s"/></speak>`
    const params = {
      OutputFormat: "pcm",
      SampleRate: "16000", // Hz
      TextType: "ssml",
      Text: wrappedSsmlText,
      VoiceId: "Amy",
    };

    //@ts-ignore
    const data = await pollyClient.send(new SynthesizeSpeechCommand(params));
    if (!data.AudioStream) return;
    const audioBytes = await data.AudioStream.transformToByteArray();
    return audioBytes;
  } catch (err) {
    console.error("Error synthesizing speech:", err);
  }
};
