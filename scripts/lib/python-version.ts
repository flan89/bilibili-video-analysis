/** ASR 锁定依赖支持的最低 Python 版本。 */
export const ASR_PYTHON_MIN_VERSION = "3.10";

export interface PythonMajorMinorVersion {
  /** Python 主版本号。 */
  major: number;
  /** Python 次版本号。 */
  minor: number;
  /** 从命令输出中解析出的主次版本文本。 */
  version: string;
}

/** 从 `python --version` 输出中解析主次版本。 */
export function parsePythonMajorMinor(versionText: string): PythonMajorMinorVersion | undefined {
  const match = versionText.match(/Python (\d+)\.(\d+)/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    version: `${match[1]}.${match[2]}`,
  };
}

/** 判断 Python 是否满足当前 ASR 锁定依赖的最低版本。 */
export function isAsrPythonSupported(versionText: string): boolean {
  const parsed = parsePythonMajorMinor(versionText);
  if (!parsed) return false;
  return parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 10);
}
