import { SynthesizeSpeechCommand, PollyClient } from "@aws-sdk/client-polly";

const pollyClient = new PollyClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: process.env.AWS_SESSION_TOKEN!,
  },
});

export const synthesizeSpeech = async (
  text: string
): Promise<any | undefined> => {
  try {
    const wrappedSsmlText = "<speak>" + text + `<break time="2s"/></speak>`;
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
