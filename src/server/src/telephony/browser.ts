import { Session } from "../types";

export class BrowserIntegration {
  isOn: boolean;

  constructor(isOn: boolean = false, app: any) {
    if (!isOn) return;

    this.isOn = isOn;
    console.log("Browser integration initialized");
  }

  async tryProcessAudioInput(msg: Buffer, session: Session) {
    if (!this.isOn) return

    try {
      const jsonMsg = JSON.parse(msg.toString());
      const audioBuffer = Buffer.from(
        jsonMsg.event.audioInput.content,
        "base64"
      );
      await session.streamAudio(audioBuffer);
    } catch (e) {}
  }

  async tryProcessAudioOutput(data: any, clients) {
    if (!this.isOn) return

    const message = JSON.stringify({ event: { audioOutput: { ...data } } });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    });
  }
}
