import * as aws from "aws-sdk";

const bedrockAgent = new aws.BedrockAgentRuntime({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
});

function queryKb(kbId: string, query: string): OutputData | number {
  const knowledgeBaseId = getKnowledgeBaseId();
  try {
    const response = bedrockAgent
      .retrieve({
        knowledgeBaseId: knowledgeBaseId,
        retrievalQuery: {
          text: query,
        },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 5,
          },
        },
      })
      .promise();

    const results: Result[] = [];

    response.then((data) => {
      for (const item of data.retrievalResults || []) {
        const result: Result = {
          content: item.content?.text || "",
          location: item.location?.s3Location?.uri || "",
          score: item.score || 0.0,
        };

        if (item.metadata) {
          result.metadata = item.metadata;
        }

        results.push(result);
      }

      const output: OutputData = {
        query: query,
        results: results,
        result_count: results.length,
      };

      return output;
    });

    return null;
  } catch (e) {
    console.error(`Error querying knowledge base: ${e}`);
    return null;
  }
}
