import os
import boto3
import time
from urllib import parse
from typing import Optional
from dataclasses import dataclass
from requests_aws4auth import AWS4Auth
from opensearchpy import OpenSearch, RequestsHttpConnection, OpenSearchException
import cfnresponse


@dataclass
class IndexConfig:
    """Configuration for OpenSearch index creation."""

    host: str
    index_name: str
    metadata_field_name: str
    text_field_name: str
    vector_field_name: str
    vector_size: int = 1024


class OpenSearchClient:
    """Handles OpenSearch operations."""

    def __init__(self, host: str):
        """Initialize OpenSearch client with AWS authentication."""
        self.host = host
        self.client = self._create_client()

    def _get_aws_auth(self) -> AWS4Auth:
        """Create AWS authentication object."""
        credentials = boto3.Session().get_credentials()
        return AWS4Auth(
            credentials.access_key,
            credentials.secret_key,
            os.environ["AWS_REGION"],
            "aoss",
            session_token=credentials.token,
        )

    def _create_client(self) -> OpenSearch:
        """Create and configure OpenSearch client."""
        return OpenSearch(
            hosts=[{"host": self.host, "port": 443}],
            http_auth=self._get_aws_auth(),
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
            timeout=300,
        )

    def create_index(self, config: IndexConfig) -> dict:
        """
        Create an index with the specified configuration.

        Args:
            config: IndexConfig object containing index configuration

        Returns:
            dict: Response from OpenSearch

        Raises:
            OpenSearchException: If index creation fails
        """
        try:
            print(f"Creating {config.index_name} on {self.host}")

            index_body = {
                "settings": {"index.knn": True},
                "mappings": {
                    "properties": {
                        config.metadata_field_name: {"type": "text", "index": False},
                        config.text_field_name: {"type": "text"},
                        "id": {
                            "type": "text",
                            "fields": {
                                "keyword": {"type": "keyword", "ignore_above": 256}
                            },
                        },
                        "x-amz-bedrock-kb-source-uri": {
                            "type": "text",
                            "fields": {
                                "keyword": {"type": "keyword", "ignore_above": 256}
                            },
                        },
                        config.vector_field_name: {
                            "type": "knn_vector",
                            "dimension": config.vector_size,
                            "method": {
                                "name": "hnsw",
                                "engine": "faiss",
                                "parameters": {"ef_construction": 512, "m": 16},
                            },
                        },
                    }
                },
            }

            response = self.client.indices.create(
                index=config.index_name, body=index_body
            )
            # TODO: figure out why the index creation signal has to be delayed for KB to be created successfully
            # this sleep fixes this error: "The knowledge base storage configuration provided is invalid...
            # Dependency error document status code: 404, error message: no such index [bedrock-knowledge-base-default-index]"
            time.sleep(5)
            print(response)
            return response

        except OpenSearchException as e:
            print(f"Error creating index: {str(e)}")
            raise


class ResourceProperties:
    """Handles resource properties from Lambda event."""

    def __init__(self, event: dict):
        self.properties = event.get("ResourceProperties", {})

    def get_property(self, key: str, required: bool = True) -> Optional[str]:
        """
        Get property value with optional validation.

        Args:
            key: Property key to retrieve
            required: If True, raises error when property is missing

        Returns:
            Optional[str]: Property value or None if not required and missing

        Raises:
            RuntimeError: If required property is missing
        """
        value = self.properties.get(key)
        if required and value is None:
            raise RuntimeError(f"Required property '{key}' not found in event")
        return value


def lambda_handler(event: dict, context) -> None:
    """
    Handle Custom Resource events from CDK.

    Args:
        event: Lambda event containing resource properties
        context: Lambda context

    Raises:
        RuntimeError: If required properties are missing
    """
    # Only handle Create events
    if event["RequestType"] != "Create":
        return

    # Extract and validate properties
    props = ResourceProperties(event)
    collection_name = props.get_property("collection")
    endpoint = props.get_property("endpoint")

    # Parse endpoint URL
    hostname = parse.urlparse(endpoint).hostname

    # Create index configuration: this is what differentiates from the prebuilt KB component
    index_config = IndexConfig(
        host=hostname,
        index_name=props.get_property("vector_index_name"),
        metadata_field_name=props.get_property("metadata_field"),
        text_field_name=props.get_property("text_field"),
        vector_field_name=props.get_property("vector_field"),
        vector_size=int(props.get_property("vector_size")),
    )

    print(
        f"Creating index: {index_config.index_name} on collection {collection_name} "
        f"in endpoint {endpoint} with {index_config.vector_size} dimensions"
    )

    # Create index
    client = OpenSearchClient(hostname)
    try:
        client.create_index(index_config)
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
    except OpenSearchException as e:
        print(f"Error creating index: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {})
    except Exception as e:
        print(f"Unexpected error: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {})
