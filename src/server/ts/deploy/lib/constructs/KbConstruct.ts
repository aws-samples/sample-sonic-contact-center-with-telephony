import * as cdk from "aws-cdk-lib";
import {
  aws_ecr_assets as awsEcrAssets,
  aws_iam as iam,
  aws_lambda as lambda,
  custom_resources as customResources,
  aws_opensearchserverless as opensearchserverless,
  aws_s3 as s3,
  aws_bedrock as bedrock,
  aws_logs as logs,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface KbConstructProps {
  bucketName: string;
  indexLambdaDir: string;
}

/*
 * This is a custom construct designed to facilitate the quick deployment of more knowledge bases if that becomes necessary for this project
 */
export class KbConstruct extends Construct {
  public readonly knowledgeBaseId: string;
  public readonly knowledgeBaseArn: string;

  constructor(scope: Construct, id: string, props: KbConstructProps) {
    super(scope, id);

    // For restrictions around how resources can be named: ^[a-z][a-z0-9-]{2,31}$
    const lowerCaseStackName = cdk.Stack.name.toLowerCase().slice(0, 15);
    const indexLambdaCloudWatchLogsPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [`*`],
        }),
      ],
    });
    const indexLambdaRole = new iam.Role(this, "IndexLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    indexLambdaRole.attachInlinePolicy(
      new iam.Policy(this, "IndexLambdaCloudWatchLogsPolicy", {
        document: indexLambdaCloudWatchLogsPolicy,
      })
    );
    const knowledgeBaseRole = new iam.Role(this, "knowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
    });

    const kbCollection = new opensearchserverless.CfnCollection(
      this,
      "kbCollection",
      {
        name: `${lowerCaseStackName}-collection`,
        description: "",
        type: "VECTORSEARCH",
      }
    );
    const securityPolicy = new opensearchserverless.CfnSecurityPolicy(
      this,
      "SecurityPolicy",
      {
        name: `${lowerCaseStackName}-securitypolicy`,
        type: "encryption",
        policy: JSON.stringify({
          Rules: [
            {
              ResourceType: "collection",
              Resource: [`collection/${kbCollection.name}`],
            },
          ],
          AWSOwnedKey: true,
        }),
      }
    );

    kbCollection.addDependency(securityPolicy);
    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(
      this,
      "NetworkPolicy",
      {
        name: `${lowerCaseStackName}-networkpolicy`,
        type: "network",
        policy: JSON.stringify([
          {
            Rules: [
              {
                ResourceType: "collection",
                Resource: [`collection/${kbCollection.name}`],
              },
            ],
            AllowFromPublic: true,
          },
        ]),
      }
    );

    kbCollection.addDependency(networkPolicy);

    // data access policy
    const sportsDataAccessPolicy = new opensearchserverless.CfnAccessPolicy(
      this,
      "DataAccessPolicy",
      {
        name: `${lowerCaseStackName}-dataaccesspolicy`,
        type: "data",
        policy: JSON.stringify([
          {
            Rules: [
              {
                ResourceType: "collection",
                Resource: [`collection/${kbCollection.name}`],
                Permission: [
                  "aoss:CreateCollectionItems",
                  "aoss:DeleteCollectionItems",
                  "aoss:UpdateCollectionItems",
                  "aoss:DescribeCollectionItems",
                ],
              },
              {
                ResourceType: "index",
                Resource: [`index/${kbCollection.name}/*`],
                Permission: [
                  "aoss:CreateIndex",
                  "aoss:DeleteIndex",
                  "aoss:UpdateIndex",
                  "aoss:DescribeIndex",
                  "aoss:ReadDocument",
                  "aoss:WriteDocument",
                ],
              },
            ],
            Principal: [knowledgeBaseRole.roleArn, indexLambdaRole.roleArn],
          },
        ]),
      }
    );

    kbCollection.addDependency(sportsDataAccessPolicy);

    const datasetS3Bucket = s3.Bucket.fromBucketName(
      this,
      "dataset-bucket",
      props.bucketName
    );

    datasetS3Bucket.grantRead(knowledgeBaseRole);

    // Custom resource lambda must be called after aoss creation but before the kb creation to create an index
    // This log group prevents deletion when deploy fails
    const lambdaLogGroup = new logs.LogGroup(
      this,
      `CollectionIndexCreator-Logs`,
      {
        retention: logs.RetentionDays.ONE_WEEK,
      }
    );

    indexLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [lambdaLogGroup.logGroupArn],
      })
    );

    const image = lambda.DockerImageCode.fromImageAsset(props.indexLambdaDir, {
      platform: awsEcrAssets.Platform.LINUX_ARM64,
    });

    const indexLambda = new lambda.DockerImageFunction(
      this,
      "CollectionIndexCreator",
      {
        code: image,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(30),
        role: indexLambdaRole,
        logGroup: lambdaLogGroup,
      }
    );

    const indexCreator = new customResources.AwsCustomResource(
      this,
      "CustomCollectionIndexCreator",
      {
        onCreate: {
          service: "Lambda",
          action: "invoke",
          parameters: {
            FunctionName: indexLambda.functionName,
            Payload: JSON.stringify({
              RequestType: "Create",
              ResourceProperties: {
                collection: kbCollection.name,
                endpoint: kbCollection.attrCollectionEndpoint,
                vector_index_name: "bedrock-knowledge-base-default-index",
                vector_size: 1536, // Depends on embeddings model
                metadata_field: "AMAZON_BEDROCK_METADATA",
                text_field: "AMAZON_BEDROCK_TEXT_CHUNK",
                vector_field: "bedrock-knowledge-base-default-vector",
              },
            }),
          },
          physicalResourceId: customResources.PhysicalResourceId.of(
            `${lowerCaseStackName}CustomCollectionIndexCreator`
          ),
        },
        policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
          resources: customResources.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      }
    );

    indexLambda.grantInvoke(indexCreator);
    indexCreator.node.addDependency(kbCollection);
    indexLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IndexCreationLambdaAccessPolicy",
        effect: iam.Effect.ALLOW,
        resources: [kbCollection.attrArn],
        actions: ["aoss:APIAccessAll"],
      })
    );

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${lowerCaseStackName}-KnowledgeBase`,
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.titan-embed-g1-text-02`,
        },
      },
      storageConfiguration: {
        type: "OPENSEARCH_SERVERLESS",
        opensearchServerlessConfiguration: {
          collectionArn: kbCollection.attrArn,
          vectorIndexName: "bedrock-knowledge-base-default-index",
          fieldMapping: {
            metadataField: "AMAZON_BEDROCK_METADATA",
            textField: "AMAZON_BEDROCK_TEXT_CHUNK",
            vectorField: "bedrock-knowledge-base-default-vector",
          },
        },
      },
    });

    // Resource creation order
    // AOSS collection -> customResourceHandlerLambda -> indexCreator -> (invoking customResourceHandlerLambda creating the index) -> knowledgeBase
    knowledgeBase.node.addDependency(indexCreator);

    // Knowledge Base requires AOSS all perms
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["aoss:*"],
        resources: [kbCollection.attrArn],
      })
    );

    const knowledgeBaseDataSource = new bedrock.CfnDataSource(
      this,
      "knowledgeBaseDataSource",
      {
        dataSourceConfiguration: {
          s3Configuration: {
            bucketArn: datasetS3Bucket.bucketArn,
          },
          type: "S3",
        },
        knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
        name: "KnowledgeBaseDataSource",
        dataDeletionPolicy: "RETAIN",
        vectorIngestionConfiguration: {
          chunkingConfiguration: {
            chunkingStrategy: "NONE",
          },
        },
      }
    );
    const bedrockPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: ["*"],
        }),
      ],
    });
    knowledgeBaseRole.attachInlinePolicy(
      new iam.Policy(this, "KbBedrockPolicy", {
        document: bedrockPolicy,
      })
    );

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
    this.knowledgeBaseArn = knowledgeBase.attrKnowledgeBaseArn;
  }
}

export default KbConstruct;
