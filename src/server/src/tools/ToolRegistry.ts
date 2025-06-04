import { Tool } from "./Tool";
import { DOMParser } from "xmldom";
import { synthesizeSpeech } from "../tts";
import { NovaSonicBidirectionalStreamClient } from "../client";
import { WebSocket } from "ws";

function startAudioContent(
  ws: WebSocket,
  promptName: string,
  contentName: string
): any {
  const event = {
    event: {
      contentStart: {
        promptName,
        contentName,
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
  ws.send(JSON.stringify(event));
  return event;
}

function endAudioContent(
  ws: WebSocket,
  promptName: string,
  contentName: string
): any {
  const event = {
    event: {
      contentEnd: {
        promptName,
        contentName,
        contentType: "SILENT_AUDIO",
      },
    },
  };
  ws.send(JSON.stringify(event));
  return event;
}

async function triggerSonic(
  client: NovaSonicBidirectionalStreamClient,
  ws: WebSocket,
  toolUseContent: any,
  message: string
) {
  const audioData = await synthesizeSpeech(message);
  const hardcodedSessionId = "a8c43fa3-cb29-4625-9fad-7a5589b19ca6";
  const { promptName } = toolUseContent;
  const contentName = client.contentNames.get(hardcodedSessionId);

  console.log("Starting silent audio stream WS");
  startAudioContent(ws, promptName, contentName);

  if (audioData) {
    const audioBytes =
      audioData instanceof Uint8Array ? audioData : new Uint8Array(audioData);
    const chunkSize = 1024;

    for (let i = 0; i < audioBytes.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, audioBytes.length);
      const chunk = audioBytes.slice(i, end);
      const pcmData = new Int16Array(chunk.length / 2);
      for (let j = 0; j < chunk.length; j += 2) {
        pcmData[j / 2] = (chunk[j + 1] << 8) | chunk[j];
      }
      const base64Data = btoa(
        String.fromCharCode.apply(null, new Uint8Array(pcmData.buffer))
      );

      for (let i = 0; i < audioBytes.length; i += chunkSize) {
        const event = {
          event: {
            audioInput: {
              role: "USER",
              promptName,
              contentName,
              content: base64Data,
            },
          },
        };
        ws.send(JSON.stringify(event));
      }
    }
    setTimeout(() => {
      endAudioContent(ws, promptName, contentName);
      console.log("sent silent audio to WS");
    }, 1000);
  }
}

const functions = {
  check_messages: async (
    client: NovaSonicBidirectionalStreamClient,
    ws: WebSocket,
    toolUseContent: any,
    messagesList: string[]
  ) => {
    return {
      content: `The following messages are for the assistant to pass on to the user: [${messagesList.toString()}]`,
    };
  },

  check_connection: async (
    client: NovaSonicBidirectionalStreamClient,
    ws: WebSocket,
    toolUseContent: any,
    messagesList: string[]
  ) => {
    setTimeout(() => {
      const message =
        "I've reviewed your connection status and detected that in the last 24 hours there were some problems registering your equipment on the network. This could have affected your service quality. To better understand what happened, I'm going to check if any specific outages were recorded that could have impacted your connection. Before we continue, can I verify that you're still there?";
      messagesList.push(message);
      console.log(`Added message to messagesList: ${message}`);
      setTimeout(() => {
        triggerSonic(
          client,
          ws,
          toolUseContent,
          "Do you have any messages for me?"
        );
      }, 3000);
    }, 5000);
    return {
      content:
        "I'm reviewing your connection status now, including anything that may have affected it.",
    };
  },

  check_for_outage: async (
    client: NovaSonicBidirectionalStreamClient,
    ws: WebSocket,
    toolUseContent: any,
    messagesList: string[]
  ) => {
    const { affectsAllUserDevices } = JSON.parse(toolUseContent.content);

    if (affectsAllUserDevices) {
      return {
        content:
          "I confirmed that there's a massive outage in your area that's affecting your internet service. You can manage your service continuity pack through the MiPersonal app or website, as long as you meet the requirements. We'll notify you when service is restored. Do you want a copy of all the information I just said to be sent to you via SMS?",
      };
    } else {
      functions.check_connection(client, ws, toolUseContent, messagesList);
      return {
        content:
          "I checked, and I couldn't find any evidence of an outage in your area. I'm going to check if your connection had any issues in the past 24 hours. Please wait a moment",
      };
    }
  },

  get_weather: async (
    client: NovaSonicBidirectionalStreamClient,
    ws: WebSocket,
    toolUseContent: any,
    messagesList: string[]
  ) => {
    const { latitude, longitude } = JSON.parse(toolUseContent.content);

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": "MyApp/1.0",
          Accept: "application/json",
        },
      });
      const weatherData = await response.json();
      console.log("weatherData:", weatherData);

      return {
        weather_data: weatherData,
      };
    } catch (error) {
      console.error(`Error fetching weather data: ${error}`);
      throw error;
    }
  },
};

function parseToolsFromXML(
  xmlString: string,
  functions: Record<string, Function> = {}
): Array<typeof Tool> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");
  const tools = doc.getElementsByTagName("tool");

  const toolClasses: Array<typeof Tool> = [];

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const id = tool.getAttribute("id")!;
    const functionName = tool.getAttribute("function")!;
    const description = tool.getAttribute("description")!;
    const properties = tool.getElementsByTagName("property");

    const schema = {
      type: "object",
      properties: {} as any,
      required: [] as string[],
    };

    for (let j = 0; j < properties.length; j++) {
      const prop = properties[j];
      const name = prop.getAttribute("name")!;
      const type = prop.getAttribute("type")!;
      const required = prop.getAttribute("required") === "true";
      const desc = prop.getAttribute("description")!;

      schema.properties[name] = {
        type: type,
        description: desc,
      };

      if (required) {
        schema.required.push(name);
      }
    }

    const toolClass = class extends Tool {
      public static id = id;
      public static schema = schema;
      public static toolSpec = {
        toolSpec: {
          name: id,
          description: description,
          inputSchema: {
            json: JSON.stringify(schema),
          },
        },
      };

      public static async execute(
        client: NovaSonicBidirectionalStreamClient,
        ws: WebSocket,
        toolUseContent: any,
        messagesList: string[]
      ) {
        const func = functions[functionName];
        if (func) {
          return await func(client, ws, toolUseContent, messagesList);
        }
        return {};
      }
    };

    Object.defineProperty(toolClass, "name", { value: id });
    toolClasses.push(toolClass);
  }

  return toolClasses;
}

export const registeredTools = parseToolsFromXML(
  `
<tool id="check_messages" function="check_messages" description="Use this tool to check if there's a connection issue in the user's area. Do not assume how many devices are affected without asking."/>
<tool id="check_connection" function="check_connection" description="Use this tool to check if there's a connection issue in the user's area. Do not assume how many devices are affected without asking."/>
<tool id="check_for_outage" function="check_for_outage" description="Use this tool to check if there's an outage in the user's area. Do not assume how many devices are affected without asking.">
  <property name="affectsAllUserDevices" type="boolean" required="true" description="Whether the outage affects all user devices" />
</tool>
<tool id="get_weather" function="get_weather" description="Get the current weather for a given location, based on its WGS84 coordinates.">
  <property name="latitude" type="string" required="true" description="Geographical WGS84 latitude of the location." />
  <property name="longitude" type="string" required="true" description="Geographical WGS84 longitude of the location." />
</tool>
`,
  functions
);

export class ToolRegistry {
  private tools: Map<
    string,
    (
      client: NovaSonicBidirectionalStreamClient,
      ws: WebSocket,
      content: any,
      messagesList: string[]
    ) => Promise<any>
  > = new Map();
  public messagesList: string[] = [];

  constructor() {
    this.registerXMLTools();
    // Add startup scripts here.
  }

  getToolSpecs() {
    return registeredTools.map((ToolClass) => ToolClass.toolSpec);
  }

  private registerXMLTools(): void {
    registeredTools.forEach((ToolClass) => {
      this.tools.set(ToolClass.id, ToolClass.execute.bind(ToolClass));
    });
  }

  async execute(
    client: NovaSonicBidirectionalStreamClient,
    ws: WebSocket,
    toolName: string,
    content: any
  ): Promise<any> {
    const handler = this.tools.get(toolName);
    if (!handler) {
      throw new Error(`Tool ${toolName} not supported`);
    }
    return handler(client, ws, content, this.messagesList);
  }
}

export default registeredTools;
