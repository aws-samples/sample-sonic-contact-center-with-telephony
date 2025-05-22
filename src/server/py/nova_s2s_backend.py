import asyncio
import websockets
import json
import base64
import warnings
import uuid

from aws_sdk_bedrock_runtime.client import (
    BedrockRuntimeClient,  # Use BedrockRuntimeClient instead of BedrockRuntime
    InvokeModelWithBidirectionalStreamOperationInput,
)
from aws_sdk_bedrock_runtime.models import (
    InvokeModelWithBidirectionalStreamInputChunk,
    BidirectionalInputPayloadPart,
)
from aws_sdk_bedrock_runtime.config import (
    Config,
    HTTPAuthSchemeResolver,
    SigV4AuthScheme,
)
from smithy_aws_core.credentials_resolvers.environment import (
    EnvironmentCredentialsResolver,
)

import knowledge_base_lookup
import retrieve_user_profile

# Suppress warnings
warnings.filterwarnings("ignore")

# Debug mode flag
DEBUG = False

def debug_print(message):
    """Print only if debug mode is enabled"""
    if DEBUG:
        print(message)


class BedrockStreamManager:
    """Manages bidirectional streaming with AWS Bedrock using asyncio"""

    def __init__(self, model_id='amazon.nova-sonic-v1:0', region='us-east-1'):
        """Initialize the stream manager."""
        self.model_id = model_id
        self.region = region

        # Audio and output queues
        self.audio_input_queue = asyncio.Queue()
        self.output_queue = asyncio.Queue()

        self.response_task = None
        self.stream_response = None
        self.is_active = False
        self.bedrock_client = None

        # Session information
        self.prompt_name = None  # Will be set from frontend
        self.content_name = None  # Will be set from frontend
        self.audio_content_name = None  # Will be set from frontend
        self.toolUseContent = ""
        self.toolUseId = ""
        self.toolName = ""

    def _initialize_client(self):
        """Initialize the Bedrock client."""
        config = Config(
            endpoint_uri=f"https://bedrock-runtime.{self.region}.amazonaws.com",
            region=self.region,
            aws_credentials_identity_resolver=EnvironmentCredentialsResolver(),
            http_auth_scheme_resolver=HTTPAuthSchemeResolver(),
            http_auth_schemes={"aws.auth#sigv4": SigV4AuthScheme()},
        )
        self.bedrock_client = BedrockRuntimeClient(config=config)

    async def initialize_stream(self):
        """Initialize the bidirectional stream with Bedrock."""
        if not self.bedrock_client:
            self._initialize_client()

        try:
            self.stream_response = (
                await self.bedrock_client.invoke_model_with_bidirectional_stream(
                    InvokeModelWithBidirectionalStreamOperationInput(
                        model_id=self.model_id
                    )
                )
            )
            self.is_active = True

            # Start listening for responses
            self.response_task = asyncio.create_task(self._process_responses())

            # Start processing audio input
            asyncio.create_task(self._process_audio_input())

            # Wait a bit to ensure everything is set up
            await asyncio.sleep(0.1)

            debug_print("Stream initialized successfully")
            return self
        except Exception as e:
            self.is_active = False
            print(f"Failed to initialize stream: {str(e)}")
            raise

    async def send_raw_event(self, event_data):
        """Send a raw event to the Bedrock stream."""
        if not self.stream_response or not self.is_active:
            debug_print("Stream not initialized or closed")
            return

        # Convert to JSON string if it's a dict
        if isinstance(event_data, dict):
            event_json = json.dumps(event_data)
        else:
            event_json = event_data

        # Create the event chunk
        event = InvokeModelWithBidirectionalStreamInputChunk(
            value=BidirectionalInputPayloadPart(bytes_=event_json.encode("utf-8"))
        )

        try:
            await self.stream_response.input_stream.send(event)
            if DEBUG:
                if len(event_json) > 200:
                    if isinstance(event_data, dict):
                        event_type = list(event_data.get("event", {}).keys())
                    else:
                        event_type = list(json.loads(event_json).get("event", {}).keys())
                    debug_print(f"Sent event type: {event_type}")
                else:
                    debug_print(f"Sent event: {event_json}")
        except Exception as e:
            debug_print(f"Error sending event: {str(e)}")
            if DEBUG:
                import traceback
                traceback.print_exc()

    async def _process_audio_input(self):
        """Process audio input from the queue and send to Bedrock."""
        while self.is_active:
            try:
                # Get audio data from the queue
                data = await self.audio_input_queue.get()

                # Extract data from the queue item
                prompt_name = data.get('prompt_name')
                content_name = data.get('content_name')
                audio_bytes = data.get('audio_bytes')

                if not audio_bytes or not prompt_name or not content_name:
                    debug_print("Missing required audio data properties")
                    continue

                # Create the audio input event
                audio_event = {
                    "event": {
                        "audioInput": {
                            "promptName": prompt_name,
                            "contentName": content_name,
                            "content": audio_bytes.decode('utf-8') if isinstance(audio_bytes, bytes) else audio_bytes,
                            "role": "USER"
                        }
                    }
                }

                # Send the event
                await self.send_raw_event(audio_event)

            except asyncio.CancelledError:
                break
            except Exception as e:
                debug_print(f"Error processing audio: {e}")
                if DEBUG:
                    import traceback
                    traceback.print_exc()

    def add_audio_chunk(self, prompt_name, content_name, audio_data):
        """Add an audio chunk to the queue."""
        # The audio_data is already a base64 string from the frontend
        self.audio_input_queue.put_nowait({
            'prompt_name': prompt_name,
            'content_name': content_name,
            'audio_bytes': audio_data
        })

    async def _process_responses(self):
        """Process incoming responses from Bedrock."""
        try:
            while self.is_active:
                try:
                    output = await self.stream_response.await_output()
                    result = await output[1].receive()
                    if result.value and result.value.bytes_:
                        try:
                            response_data = result.value.bytes_.decode('utf-8')
                            json_data = json.loads(response_data)

                            # Handle different response types
                            if 'event' in json_data:
                                # Handle tool use detection
                                if 'toolUse' in json_data['event']:
                                    self.toolUseContent = json_data['event']['toolUse']
                                    self.toolName = json_data['event']['toolUse']['toolName']
                                    self.toolUseId = json_data['event']['toolUse']['toolUseId']
                                    debug_print(f"Tool use detected: {self.toolName}, ID: {self.toolUseId}")

                                # Process tool use when content ends
                                elif 'contentEnd' in json_data['event'] and json_data['event'].get('contentEnd', {}).get('type') == 'TOOL':
                                    debug_print("Processing tool use and sending result")
                                    toolResult = await self.processToolUse(self.toolName, self.toolUseContent)

                                    # Send tool start event
                                    toolContent = str(uuid.uuid4())
                                    tool_start_event = {
                                        "event": {
                                            "contentStart": {
                                                "promptName": self.prompt_name,
                                                "contentName": toolContent,
                                                "interactive": True,
                                                "type": "TOOL",
                                                "role": "TOOL",
                                                "toolResultInputConfiguration": {
                                                    "toolUseId": self.toolUseId,
                                                    "type": "TEXT",
                                                    "textInputConfiguration": {
                                                        "mediaType": "text/plain"
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    await self.send_raw_event(tool_start_event)

                                    # Send tool result event
                                    if isinstance(toolResult, dict):
                                        content_json_string = json.dumps(toolResult)
                                    else:
                                        content_json_string = toolResult

                                    tool_result_event = {
                                        "event": {
                                            "toolResult": {
                                                "promptName": self.prompt_name,
                                                "contentName": toolContent,
                                                "content": content_json_string,
                                            }
                                        }
                                    }
                                    await self.send_raw_event(tool_result_event)

                                    # Send tool content end event
                                    tool_content_end_event = {
                                        "event": {
                                            "contentEnd": {
                                                "promptName": self.prompt_name,
                                                "contentName": toolContent
                                            }
                                        }
                                    }
                                    await self.send_raw_event(tool_content_end_event)

                            # Put the response in the output queue for forwarding to the frontend
                            await self.output_queue.put(json_data)
                        except json.JSONDecodeError:
                            await self.output_queue.put({"raw_data": response_data})
                except StopAsyncIteration:
                    # Stream has ended
                    break
                except Exception as e:
                   # Handle ValidationException properly
                    if "ValidationException" in str(e):
                        error_message = str(e)
                        print(f"Validation error: {error_message}")
                    else:
                        print(f"Error receiving response: {e}")
                    break

        except Exception as e:
            print(f"Response processing error: {e}")
        finally:
            self.is_active = False

    async def processToolUse(self, toolName, toolUseContent):
        """Return the tool result"""
        tool = toolName.lower()
        debug_print(f"Tool Use Content: {toolUseContent}")

        if tool == "lookup":
            # Extract query from toolUseContent
            if isinstance(toolUseContent, dict) and 'content' in toolUseContent:
                    # Parse the JSON string in the content field
                    query_json = json.loads(toolUseContent.get("content"))
                    query = query_json.get("query", "")
                    print(f"Extracted query: {query}")

                    # Call the knowledge base lookup
                    results = knowledge_base_lookup.main(query)

            return {"content": json.dumps(results)}

        elif tool == "userprofilesearch":
            print("doing user profile search")
            if isinstance(toolUseContent, dict) and "content" in toolUseContent:
                # Parse the JSON string in the content field
                phone_number_json = json.loads(toolUseContent.get("content"))
                phone_number = phone_number_json.get("phone_number", "")
                print(phone_number)
                print(f"Extracted phone number: {phone_number}")

                results = retrieve_user_profile.main(phone_number)

            print(results)
            return {"content": json.dumps(results)}

        return {}

    async def close(self):
        """Close the stream properly."""
        if not self.is_active:
            return

        self.is_active = False

        if self.stream_response:
            await self.stream_response.input_stream.close()

        if self.response_task and not self.response_task.done():
            self.response_task.cancel()
            try:
                await self.response_task
            except asyncio.CancelledError:
                pass


async def websocket_handler(websocket):
    """Handle WebSocket connections from the frontend."""
    # Create a new stream manager for this connection
    stream_manager = BedrockStreamManager(model_id='amazon.nova-sonic-v1:0', region='us-east-1')

    # Initialize the Bedrock stream
    await stream_manager.initialize_stream()

    # Start a task to forward responses from Bedrock to the WebSocket
    forward_task = asyncio.create_task(forward_responses(websocket, stream_manager))

    try:
        async for message in websocket:
            try:
                data = json.loads(message)

                if 'event' in data:
                    event_type = list(data['event'].keys())[0]

                    # Store prompt name and content names if provided
                    if event_type == 'promptStart':
                        stream_manager.prompt_name = data['event']['promptStart']['promptName']
                    elif event_type == 'contentStart' and data['event']['contentStart'].get('type') == 'AUDIO':
                        stream_manager.audio_content_name = data['event']['contentStart']['contentName']

                    # Handle audio input separately
                    if event_type == 'audioInput':
                        # Extract audio data
                        prompt_name = data['event']['audioInput']['promptName']
                        content_name = data['event']['audioInput']['contentName']
                        audio_base64 = data['event']['audioInput']['content']

                        # Add to the audio queue
                        stream_manager.add_audio_chunk(prompt_name, content_name, audio_base64)
                    else:
                        # Send other events directly to Bedrock
                        await stream_manager.send_raw_event(data)
            except json.JSONDecodeError:
                print("Invalid JSON received from WebSocket")
            except Exception as e:
                print(f"Error processing WebSocket message: {e}")
                if DEBUG:
                    import traceback
                    traceback.print_exc()
    except websockets.exceptions.ConnectionClosed:
        print("WebSocket connection closed")
    finally:
        # Clean up
        forward_task.cancel()
        await stream_manager.close()


async def forward_responses(websocket, stream_manager):
    """Forward responses from Bedrock to the WebSocket."""
    try:
        while True:
            # Get next response from the output queue
            response = await stream_manager.output_queue.get()

            # Send to WebSocket
            try:
                await websocket.send(json.dumps(response))
            except websockets.exceptions.ConnectionClosed:
                break
    except asyncio.CancelledError:
        # Task was cancelled
        pass
    except Exception as e:
        print(f"Error forwarding responses: {e}")


async def main(debug=False):
    """Main function to run the WebSocket server."""
    global DEBUG
    DEBUG = debug

    # Start WebSocket server
    async with websockets.serve(websocket_handler, "localhost", 8081):
        print(f"WebSocket server started at ws://localhost:8081")

        # Keep the server running forever
        await asyncio.Future()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description='Bedrock WebSocket Server')
    parser.add_argument('--debug', action='store_true', help='Enable debug mode')
    args = parser.parse_args()

    # Run the main function
    try:
        asyncio.run(main(debug=args.debug))
    except KeyboardInterrupt:
        print("Server stopped by user")
    except Exception as e:
        print(f"Server error: {e}")
        if args.debug:
            import traceback
            traceback.print_exc()
