import { Conversation } from "../client";

export class BrowserIntegration {
  isOn: boolean;

  constructor(isOn: boolean = false, app: any) {
    if (!isOn) return;

    this.isOn = isOn;
    console.log("Browser integration initialized");
  }

  async tryProcessAudioInput(msg: Buffer, conversation: Conversation) {
    if (!this.isOn) return

    try {
      const jsonMsg = JSON.parse(msg.toString());
      const audioBuffer = Buffer.from(
        jsonMsg.event.audioInput.content,
        "base64"
      );
      await conversation.streamAudio(audioBuffer);
    } catch (e) {}
  }

  async tryProcessAudioOutput(data: any, clients) {
    if (!this.isOn) return

    console.log(29)

    const message = JSON.stringify({ event: { audioOutput: { ...data } } });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    });
  }
}
