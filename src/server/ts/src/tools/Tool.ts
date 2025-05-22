export const DefaultToolSchema = {
  type: "object",
  properties: {},
  required: [],
};

export abstract class Tool {
  public static id: string;
  public static schema: {
    type?: string;
    properties: any;
    required: string[];
  }
  public static toolSpec: {
    toolSpec: {
      name: string;
      description: string;
      inputSchema: {
        json: any;
      };
    };
  };

  public static async execute(toolUseContent: any, messagesList: string[]): Promise<any> {
    return {};
  }
}

export function parseToolsFromXML(xmlString, functions = {}) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  const tools = doc.querySelectorAll('tool');

  const toolClasses = [];

  tools.forEach(tool => {
    const id = tool.getAttribute('id');
    const functionName = tool.getAttribute('function');
    const description = tool.getAttribute('description');
    const properties = tool.querySelectorAll('property');

    const schema = {
      type: "object",
      properties: {},
      required: []
    };

    properties.forEach(prop => {
      const name = prop.getAttribute('name');
      const type = prop.getAttribute('type');
      const required = prop.getAttribute('required') === 'true';
      const desc = prop.getAttribute('description');

      schema.properties[name] = {
        type: type,
        description: desc
      };

      if (required) {
        schema.required.push(name);
      }
    });

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

      public static async execute(toolUseContent, messagesList) {
        const func = functions[functionName];
        if (func) {
          return await func(toolUseContent, messagesList);
        }
        return {};
      }
    };

    Object.defineProperty(toolClass, 'name', { value: `${id}Tool` });
    toolClasses.push(toolClass);
  });

  return toolClasses;
 }
