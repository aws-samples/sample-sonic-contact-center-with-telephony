import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

import config from "./config";

function initializeBedrockClient() {
  return new BedrockRuntimeClient({
    region: config.aws.region,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
      sessionToken: config.aws.sessionToken, // Optional, include if you're using temporary credentials
    },
  });
}

/**
 * Analyze sentiment of the latest user message using Bedrock
 * @param {string} message - The user's message text to analyze
 * @returns {Promise<number>} - Sentiment score from 0-100
 */
async function analyzeSentiment(message) {
  try {
    const client = initializeBedrockClient();
    console.log("client", client)

    const command = new ConverseCommand({
      modelId: "amazon.nova-lite-v1:0",
      messages: [
        {
          role: "user",
          content: [
            {
              text: `Analyze the sentiment of this message and return only a number between 0 and 100, where 0 to 33 is extremely, 33-66 is neutral, and 66 to 100 is positive. This means 0 is extremely negative and 100 is extremely positive. Only return the number, no other text: "${message}"`,
            },
          ],
        },
      ],
    });
    const response = await client.send(command);
    console.debug("Bedrock sentiment response:", response)

    // Extract the sentiment score from the response
    const sentimentText = response.output.message.content[0].text.trim();
    const sentimentScore = parseInt(sentimentText, 10);

    if (isNaN(sentimentScore)) {
      console.error("Failed to parse sentiment score:", sentimentText);
      return 50; // Default to neutral if parsing fails
    }

    console.log("Bedrock sentiment analysis result:", sentimentScore);
    return sentimentScore;
  } catch (error) {
    console.error("Error analyzing sentiment with Amazon Bedrock:", error);
    // On error, return a neutral value
    return 50;
  }
}

/**
 * Generate insights based on the full conversation history using Bedrock
 * @param {Array} history - Full conversation history array
 * @returns {Promise<string>} - A single insight string
 */
async function generateInsight(history) {
  try {
    if (!history || history.length === 0) return "";

    const client = initializeBedrockClient();
    const formattedHistory = history
      .map((msg) => `${msg.sender === "user" ? "User" : "Agent"}: ${msg.text}`)
      .join("\n");

    const input = {
      modelId: "amazon.nova-lite-v1:0",
      messages: [
        {
          role: "user",
          content: [
            {
              text: `Your job is to analyze the agent's conversation to this point and provide actionable feedback for how they can better assist their customer. Based on this conversation, provide a single, brief insight about customer sentiment, needs, or interaction quality. You should phrase these as suggestions for the agent.

              Telecom Company Policy Guidelines:
              - If the customer asks questions unrelated to our telecom services or products, politely redirect them to relevant topics.
              - For off-topic personal questions, agents should respond with "I'd be happy to help with questions about our telecom services, plans, or technical support" before refocusing the conversation.
              - Never engage with politically divisive topics, instead say "I understand your interest, but let's focus on how I can assist with your mobile/internet/TV service needs today."
              - For inappropriate requests, kindly decline and offer appropriate telecom assistance alternatives.
              - For questions about competitors' services, acknowledge their question but refocus on our company's offerings without disparaging competitors.

              Return only the insight with no explanations or context. Do not generate anything other than the insight/tip.

              Example insights:
              - "The customer seems frustrated about slow internet speeds. Consider offering a speed test and troubleshooting steps."
              - "When the customer asked about political news, you could have redirected more smoothly by acknowledging then refocusing on their account needs."
              - "The customer appears confused about our data plan structure. Consider sharing a simple breakdown of our tiered options."
              - "Consider proactively offering information about our network coverage in the customer's area based on their concerns."

              Conversation:
              ${formattedHistory}`,
            },
          ],
        },
      ],
    };

    const command = new ConverseCommand(input);
    const response = await client.send(command);

    // Extract just the insight
    const insight = response.output.message.content[0].text.trim();
    console.log("Bedrock insight generation result:", insight);
    return insight;
  } catch (error) {
    console.error("Error generating insight with Amazon Bedrock:", error);
    return "";
  }
}

export { analyzeSentiment, generateInsight };
