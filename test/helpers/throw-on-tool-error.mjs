// Until 2.11 a tool that failed answered with a protocol error, which client.callTool throws. It now answers with a
// result that has isError (Claude Desktop shows those to the model; it hides protocol errors). Tests that only care
// that a call is refused, and with which message, use a client that throws on such a result, as before.
export function throwOnToolError(client) {
  const original = client.callTool.bind(client);
  client.callTool = async (...args) => {
    const result = await original(...args);
    if (result?.isError === true) {
      throw new Error(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    }
    return result;
  };
  return client;
}
