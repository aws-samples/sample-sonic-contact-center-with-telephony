import json
import boto3
import sys
import os
from dotenv import load_dotenv

def get_knowledge_base_id():
    load_dotenv()
    knowledge_base_id = os.getenv("KNOWLEDGE_BASE_ID")

    if not knowledge_base_id:
        raise ValueError("KNOWLEDGE_BASE_ID not found in .env file")

    return knowledge_base_id

def main(query):
    aws_access_key_id = os.getenv('AWS_ACCESS_KEY_ID')
    aws_secret_access_key = os.getenv('AWS_SECRET_ACCESS_KEY')

    if not all([aws_access_key_id, aws_secret_access_key]):
        raise ValueError("AWS credentials not found in environment variables")

    knowledge_base_id = get_knowledge_base_id()

    try:
        # Create the boto3 client with explicit credentials
        bedrock_agent = boto3.client(
            'bedrock-agent-runtime',
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
        )

        # Rest of your code remains the same
        response = bedrock_agent.retrieve(
            knowledgeBaseId=knowledge_base_id,
            retrievalQuery={
                'text': query
            },
            retrievalConfiguration={
                'vectorSearchConfiguration': {
                    'numberOfResults': 5
                }
            }
        )

        # Format the results
        results = []
        for item in response.get('retrievalResults', []):
            result = {
                'content': item.get('content', {}).get('text', ''),
                'location': item.get('location', {}).get('s3Location', {}).get('uri', ''),
                'score': item.get('score', 0.0)
            }

            # Add metadata if present
            if 'metadata' in item and item['metadata']:
                result['metadata'] = item['metadata']

            results.append(result)

        # Create the output JSON
        output = {
            'query': query,
            'results': results,
            'result_count': len(results)
        }

        return output

    except Exception as e:
        error = {"error": f"Error querying knowledge base: {str(e)}"}
        print(json.dumps(error))
        return 1

if __name__ == '__main__':
    sys.exit(main("Inernational Roaming Plans"))
