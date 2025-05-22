import * as cdk from "aws-cdk-lib";
import { ServerStack } from "../lib/server-stack";

const account = process.env.CDK_DEFAULT_ACCOUNT!;
const region = process.env.CDK_DEFAULT_REGION || "us-east-1";

const app = new cdk.App();

new ServerStack(app, "ServerStack", {
  env: {
    account,
    region,
  },
  description: "Server deployment with IP whitelisting",
});
