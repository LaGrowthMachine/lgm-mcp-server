import { ObjectId } from "mongodb";
import { getDb } from "../db-explorer/mongoClient";
import { McpFlowError } from "../../callFlow";

export type RawMessage = Record<string, unknown>;

export const fetchConversationMessages = async (
  conversationId: string,
): Promise<RawMessage[]> => {
  if (!/^[a-f0-9]{24}$/i.test(conversationId)) {
    throw new McpFlowError(
      "Invalid conversationId. Expected a 24-character hex string.",
      400,
    );
  }
  const oid = new ObjectId(conversationId);

  try {
    const db = await getDb();
    return await db
      .collection("inboxMessages")
      .find(
        {
          conversationId: oid,
          deleted: { $ne: true },
          $or: [
            { visibleOnlyToMembers: { $exists: false } },
            { visibleOnlyToMembers: { $size: 0 } },
          ],
        },
        {
          projection: {
            _id: 1,
            status: 1,
            type: 1,
            createdAt: 1,
            content: 1,
          },
        },
      )
      .sort({ createdAt: 1 })
      .toArray();
  } catch (err) {
    if (err instanceof McpFlowError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new McpFlowError(`Conversation fetch failed: ${message}`, 500);
  }
};
