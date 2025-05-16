export const GetNboToolSchema = JSON.stringify({
  type: "object",
  properties: {
    phoneNumber: {
      type: "string",
      description: "A string of the user's phone number",
    },
    intentType: {
      type: "string",
      description: "The user's intent. Either billing | outage | trade_in",
    },
  },
  required: ["phoneNumber", "intentType"],
});

const sampleData = {
  phone_number: {
    S: "5101234567",
  },
  billing: {
    M: {
      promotion: {
        S: "$10 credit applied to their next billing cycle",
      },
      reason: {
        S: "Customer was overcharged on previous bill",
      },
    },
  },
  outage: {
    M: {
      promotion: {
        S: "$20 credit toward their internet bill",
      },
      reason: {
        S: "Neighborhood connectivity outage",
      },
    },
  },
  trade_in: {
    M: {
      promotion: {
        S: "Trade in iPhone 14 for iPhone 15 at no extra cost. Customer will pay $20 per month",
      },
      reason: {
        S: "Customer eligible for upgrade promotion",
      },
    },
  },
};

export async function getNbo(
  phoneNumber: string,
  intentType: string
): Promise<any> {
  if (phoneNumber != "5101234567") return {};
  const item = sampleData[intentType];

  if (!item) {
    return {
      error: `No ${intentType} offer found for phone number: ${phoneNumber}`,
    };
  }

  return {
    "Best Customer Offer": item.M.promotion.S,
    Reason: item.M.reason.S,
  };
}
