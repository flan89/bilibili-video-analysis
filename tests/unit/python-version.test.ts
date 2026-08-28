import { describe, expect, it } from "vitest";

import {
  ASR_PYTHON_MIN_VERSION,
  isAsrPythonSupported,
  parsePythonMajorMinor,
} from "../../scripts/lib/python-version.js";

describe("ASR Python 版本契约", () => {
  it("最低版本固定为 3.10", () => {
    expect(ASR_PYTHON_MIN_VERSION).toBe("3.10");
  });

  it("拒绝 3.9，接受 3.10 及更高版本", () => {
    expect(isAsrPythonSupported("Python 3.9.18")).toBe(false);
    expect(isAsrPythonSupported("Python 3.10.0")).toBe(true);
    expect(isAsrPythonSupported("Python 3.14.1")).toBe(true);
    expect(isAsrPythonSupported("Python 4.0.0")).toBe(true);
  });

  it("无法解析版本时返回不支持", () => {
    expect(parsePythonMajorMinor("unknown")).toBeUndefined();
    expect(isAsrPythonSupported("unknown")).toBe(false);
  });
});
