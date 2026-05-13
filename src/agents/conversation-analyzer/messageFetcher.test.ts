import { ObjectId } from "mongodb";
import { fetchConversationMessages } from "./messageFetcher";
import { McpFlowError } from "../../callFlow";

const findMock = jest.fn();
const sortMock = jest.fn();
const toArrayMock = jest.fn();
const collectionMock = jest.fn();
const getDbMock = jest.fn();

jest.mock("../db-explorer/mongoClient", () => ({
  getDb: () => getDbMock(),
}));

const setupChain = (docs: unknown[]) => {
  toArrayMock.mockResolvedValue(docs);
  sortMock.mockReturnValue({ toArray: toArrayMock });
  findMock.mockReturnValue({ sort: sortMock });
  collectionMock.mockReturnValue({ find: findMock });
  getDbMock.mockResolvedValue({ collection: collectionMock });
};

describe("fetchConversationMessages", () => {
  const validId = "62e95347e920fa35588af34c";

  beforeEach(() => {
    findMock.mockReset();
    sortMock.mockReset();
    toArrayMock.mockReset();
    collectionMock.mockReset();
    getDbMock.mockReset();
  });

  it("rejects malformed conversationId with 400", async () => {
    await expect(fetchConversationMessages("not-an-oid")).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("queries inboxMessages with the right filter, projection, and sort", async () => {
    const docs = [{ _id: new ObjectId(), status: "SENT" }];
    setupChain(docs);

    const result = await fetchConversationMessages(validId);

    expect(getDbMock).toHaveBeenCalledTimes(1);
    expect(collectionMock).toHaveBeenCalledWith("inboxMessages");

    const [filter, options] = findMock.mock.calls[0];
    expect(filter.conversationId).toBeInstanceOf(ObjectId);
    expect(filter.conversationId.toHexString()).toBe(validId);
    expect(filter.deleted).toEqual({ $ne: true });
    expect(filter.$or).toEqual([
      { visibleOnlyToMembers: { $exists: false } },
      { visibleOnlyToMembers: { $size: 0 } },
    ]);
    expect(options.projection).toEqual({
      _id: 1,
      status: 1,
      type: 1,
      createdAt: 1,
      content: 1,
    });
    expect(sortMock).toHaveBeenCalledWith({ createdAt: 1 });
    expect(result).toBe(docs);
  });

  it("returns an empty array when the conversation has no messages", async () => {
    setupChain([]);
    await expect(fetchConversationMessages(validId)).resolves.toEqual([]);
  });

  it("wraps connection failures into McpFlowError(500)", async () => {
    getDbMock.mockRejectedValue(new Error("LGM_MONGO_URI env var is not set"));
    await expect(fetchConversationMessages(validId)).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("Conversation fetch failed"),
    });
  });

  it("wraps runtime failures into McpFlowError(500)", async () => {
    toArrayMock.mockRejectedValue(new Error("network timeout"));
    sortMock.mockReturnValue({ toArray: toArrayMock });
    findMock.mockReturnValue({ sort: sortMock });
    collectionMock.mockReturnValue({ find: findMock });
    getDbMock.mockResolvedValue({ collection: collectionMock });

    await expect(fetchConversationMessages(validId)).rejects.toBeInstanceOf(
      McpFlowError,
    );
  });
});
