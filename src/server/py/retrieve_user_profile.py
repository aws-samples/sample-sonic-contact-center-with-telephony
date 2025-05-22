#!/usr/bin/env python3
import boto3
import json
import logging
import os
import sys
from botocore.exceptions import ClientError, NoCredentialsError, ProfileNotFound
from dotenv import load_dotenv

# Configure logging
logger = logging.getLogger(__name__)
# Load environment variables from .env file
load_dotenv()


def get_dynamodb_table_name():
    """
    Loads and returns the DynamoDB table name from the .env file.
    """

    # Get the DynamoDB table name
    table_name = os.getenv("DYNAMODB_TABLE_NAME")

    if not table_name:
        raise ValueError("DYNAMODB_TABLE_NAME not found in .env file")

    return table_name


def lookup_phone_number(phone_number: str):
    """
    Looks up a phone number in DynamoDB where the phone number is the primary key.

    Args:
        phone_number (str): The phone number to look up

    Returns:
        dict: The item found in DynamoDB

    Raises:
        ValueError: If AWS credentials are missing or invalid
        ConnectionError: If there's a network issue connecting to AWS
        RuntimeError: For other DynamoDB errors
    """
    # Set AWS credentials from environment variables
    aws_access_key_id = os.getenv("AWS_ACCESS_KEY_ID")
    aws_secret_access_key = os.getenv("AWS_SECRET_ACCESS_KEY")
    aws_session_token = os.getenv("AWS_SESSION_TOKEN")
    aws_region = os.getenv(
        "AWS_REGION", "us-east-1"
    )  # Default to us-east-1 if not specified

    if not all([aws_access_key_id, aws_secret_access_key]):
        raise ValueError("AWS credentials not found in environment variables")

    try:
        table_name = get_dynamodb_table_name()

        # Create the boto3 client with explicit credentials
        dynamodb = boto3.resource(
            "dynamodb",
            region_name=aws_region,
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            aws_session_token=aws_session_token,
        )

        # Get the table
        table = dynamodb.Table(table_name)

        # Get the user info from the table
        response = table.get_item(Key={"phone_number": phone_number})

        # Check if the item was found
        if "Item" in response:
            return response["Item"]
        else:
            logger.info(f"No item found for phone number: {phone_number}")
            return None

    except (ProfileNotFound, NoCredentialsError) as e:
        logger.error(f"AWS credential error: {str(e)}")
        raise ValueError(f"AWS credential error: {str(e)}")

    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        error_message = e.response["Error"]["Message"]

        if error_code == "ResourceNotFoundException":
            logger.error(f"Table {table_name} not found: {error_message}")
            raise RuntimeError(f"DynamoDB table not found: {error_message}")
        elif error_code == "ProvisionedThroughputExceededException":
            logger.warning(f"DynamoDB throughput exceeded: {error_message}")
            raise ConnectionError(f"DynamoDB throughput exceeded: {error_message}")
        else:
            logger.error(f"DynamoDB ClientError: {error_code} - {error_message}")
            raise RuntimeError(f"DynamoDB error: {error_message}")

    except ConnectionError as e:
        logger.error(f"Network error connecting to AWS: {str(e)}")
        raise ConnectionError(f"Network error connecting to AWS: {str(e)}")

    except Exception as e:
        logger.error(f"Unexpected error querying DynamoDB: {str(e)}")
        raise RuntimeError(f"Error querying DynamoDB: {str(e)}")


def main(phone_number: str):
    """
    Main function to process phone number lookup requests.

    Args:
        phone_number (str): The phone number to look up

    Returns:
        dict: The lookup result if successful
        int: Error code (1) if an error occurred
    """
    if not phone_number:
        logger.error("No phone number provided")
        error = {"error": "No phone number provided"}
        print(json.dumps(error, indent=2))
        return 1

    try:
        # Sanitize the phone number
        clean_number = str(phone_number).replace("-", "").strip()

        if not clean_number.isdigit():
            logger.warning(f"Invalid phone number format: {phone_number}")
            error = {"error": f"Invalid phone number format: {phone_number}"}
            print(json.dumps(error, indent=2))
            return 1

        # Attempt to look up the phone number
        result = lookup_phone_number(clean_number)

        # Prepare and return the result
        if result:
            output = {
                "phone_number": phone_number,
                "clean_number": clean_number,
                "found": True,
                "data": result,
            }
        else:
            output = {
                "phone_number": phone_number,
                "clean_number": clean_number,
                "found": False,
            }

        print(json.dumps(output, indent=2))
        return result

    except ValueError as e:
        # Handle configuration/validation errors
        logger.error(f"Configuration error: {str(e)}")
        error = {"error": f"Configuration error: {str(e)}"}
        print(json.dumps(error, indent=2))
        return 1

    except ConnectionError as e:
        # Handle network/connection issues
        logger.error(f"Connection error: {str(e)}")
        error = {"error": f"Connection error: {str(e)}", "retriable": True}
        print(json.dumps(error, indent=2))
        return 1

    except RuntimeError as e:
        # Handle service-specific errors
        logger.error(f"Service error: {str(e)}")
        error = {"error": f"Service error: {str(e)}"}
        print(json.dumps(error, indent=2))
        return 1

    except Exception as e:
        # Catch-all for unexpected errors
        logger.exception(f"Unexpected error in phone number lookup: {str(e)}")
        error = {"error": f"Unexpected error: {str(e)}"}
        print(json.dumps(error, indent=2))
        return 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python script.py <phone_number>")
        sys.exit(1)

    phone_number = sys.argv[1]
    sys.exit(main(phone_number))
