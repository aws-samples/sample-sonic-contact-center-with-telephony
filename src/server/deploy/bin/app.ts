#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ServerStack } from "../lib/server-stack";

const app = new cdk.App();
new ServerStack(app, "ServerStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
  description: "Server application deployment with IP whitelisting",
});
