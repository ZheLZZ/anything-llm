jest.mock("../../../models/apiKeys", () => ({
  ApiKey: { get: jest.fn() },
}));
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));

const { ApiKey } = require("../../../models/apiKeys");
const { SystemSettings } = require("../../../models/systemSettings");
const { validApiKey } = require("../../../utils/middleware/validApiKey");

function responseMock() {
  return {
    locals: {},
    status: jest.fn(function () {
      return this;
    }),
    json: jest.fn(function () {
      return this;
    }),
  };
}

describe("validApiKey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
  });

  it("rejects a request without an API key", async () => {
    const response = responseMock();
    const next = jest.fn();

    await validApiKey({ header: jest.fn().mockReturnValue(null) }, response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(ApiKey.get).not.toHaveBeenCalled();
  });

  it("rejects an unknown API key", async () => {
    ApiKey.get.mockResolvedValue(null);
    const response = responseMock();
    const next = jest.fn();

    await validApiKey(
      { header: jest.fn().mockReturnValue("Bearer wrong-key") },
      response,
      next
    );

    expect(ApiKey.get).toHaveBeenCalledWith({ secret: "wrong-key" });
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("continues for a valid API key", async () => {
    ApiKey.get.mockResolvedValue({ id: 1 });
    const response = responseMock();
    const next = jest.fn();

    await validApiKey(
      { header: jest.fn().mockReturnValue("Bearer valid-key") },
      response,
      next
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
