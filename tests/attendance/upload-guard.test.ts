// The upload guard's refusal branches (D-170).
//
// Every check here runs BEFORE the parser sees a byte, which is the whole reason the module
// is pure: a Server Action is a public HTTP endpoint and the thing behind it is an XLS
// parser, so these branches are the boundary. Testing them needs no File, no fixture and no
// database - the functions take {name, size, lastModified} and a Uint8Array.
//
// The assertions check the DISCRIMINANT and the substrings an operator acts on, not whole
// sentences. A test that pins the full message turns every wording improvement into a
// failure, which trains the next person to update the assertion without reading it.

import { describe, expect, it } from "vitest";

import {
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  checkUploadBatch,
  checkUploadCandidate,
  checkWorkbookSignature,
  sanitiseFileMtime,
  type UploadCandidate,
} from "@/lib/attendance/upload-guard";

/** OLE2/CFB header - the real 日考勤数据模版.xls starts with exactly these eight bytes. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** ZIP local file header, i.e. what an .xlsx actually is. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** Pads a magic prefix out to a plausible file length. */
function bytesOf(magic: readonly number[], length = 64): Uint8Array {
  const buffer = new Uint8Array(length);
  buffer.set(magic, 0);
  return buffer;
}

function candidate(overrides: Partial<UploadCandidate> = {}): UploadCandidate {
  return {
    name: "日考勤数据.xls",
    size: 450_560,
    lastModified: Date.UTC(2026, 7, 11, 6, 0, 0),
    ...overrides,
  };
}

/** Narrows to the failure arm so `message` is reachable without a non-null assertion. */
function messageOf(result: ReturnType<typeof checkUploadCandidate>): string {
  if (result.ok) {
    throw new Error("Expected the guard to refuse this input, but it passed");
  }
  return result.message;
}

describe("checkUploadCandidate", () => {
  it("accepts a real attendance export by name and size", () => {
    expect(checkUploadCandidate(candidate())).toEqual({ ok: true });
  });

  it("accepts .xlsx as well - HR could switch export format without warning", () => {
    expect(checkUploadCandidate(candidate({ name: "日考勤数据.xlsx" })).ok).toBe(true);
  });

  it("matches the extension case-insensitively", () => {
    expect(checkUploadCandidate(candidate({ name: "REPORT.XLS" })).ok).toBe(true);
  });

  it("refuses Excel's ~$ lock file and says to close Excel", () => {
    // This is the one an operator hits by accident: a lock file sits beside the real
    // workbook and a select-all in the folder picks it up. The message has to name the
    // cause, because "not a workbook" would send them looking for a corrupt file.
    const message = messageOf(checkUploadCandidate(candidate({ name: "~$日考勤数据.xls" })));
    expect(message).toContain("锁文件");
    expect(message).toContain("Excel");
  });

  it("refuses a name with no accepted extension", () => {
    expect(messageOf(checkUploadCandidate(candidate({ name: "考勤.pdf" })))).toContain(".xls");
  });

  it("accepts the .csv HR now exports (D-221)", () => {
    expect(checkUploadCandidate(candidate({ name: "日考勤数据 1.csv", size: 77_600 })).ok).toBe(
      true,
    );
  });

  it("refuses an empty name - provenance would have nothing to record", () => {
    expect(messageOf(checkUploadCandidate(candidate({ name: "   " })))).toContain("文件名");
  });

  it("refuses a 0-byte file as an interrupted copy, not as a rest-day report", () => {
    // A rest-day report is a real workbook with a header and a totals row (D-170). Zero
    // bytes cannot be one, and conflating the two would let a failed copy be recorded as
    // a legitimate SUCCESS/0-row import and silently reset the D-124 staleness clock.
    expect(messageOf(checkUploadCandidate(candidate({ size: 0 })))).toContain("空");
  });

  it("refuses one byte over the per-file ceiling and quotes both sizes", () => {
    const message = messageOf(checkUploadCandidate(candidate({ size: MAX_FILE_BYTES + 1 })));
    expect(message).toContain("4.0MB");
  });

  it("accepts exactly the per-file ceiling - the limit is inclusive", () => {
    expect(checkUploadCandidate(candidate({ size: MAX_FILE_BYTES })).ok).toBe(true);
  });
});

describe("checkUploadBatch", () => {
  const small = (name: string): UploadCandidate => candidate({ name, size: 1000 });

  it("accepts a Monday backlog of three files", () => {
    expect(
      checkUploadBatch([small("sat.xls"), small("sun.xls"), small("mon.xls")]),
    ).toEqual({ ok: true });
  });

  it("refuses an empty selection", () => {
    expect(messageOf(checkUploadBatch([]))).toContain("至少一个");
  });

  it("accepts exactly MAX_FILE_COUNT files and refuses one more", () => {
    const files = Array.from({ length: MAX_FILE_COUNT }, (_unused, i) =>
      small(`day-${String(i)}.xls`),
    );
    expect(checkUploadBatch(files).ok).toBe(true);
    expect(messageOf(checkUploadBatch([...files, small("extra.xls")]))).toContain("最多上传");
  });

  it("refuses a batch whose total exceeds the batch ceiling even when every file is in bounds", () => {
    // Ten in-bounds files are not automatically an in-bounds request: the bytes are held
    // in memory together. 4 x 4MB clears every per-file check and still exceeds 12MB.
    const files = Array.from({ length: 4 }, (_unused, i) =>
      candidate({ name: `day-${String(i)}.xls`, size: MAX_FILE_BYTES }),
    );
    for (const file of files) {
      expect(checkUploadCandidate(file).ok).toBe(true);
    }
    const message = messageOf(checkUploadBatch(files));
    expect(message).toContain("合计");
    expect(message).toContain(String(files.length));
  });

  it("accepts a batch sitting exactly on the batch ceiling", () => {
    const half = Math.trunc(MAX_BATCH_BYTES / 4);
    const files = Array.from({ length: 4 }, (_unused, i) =>
      candidate({ name: `day-${String(i)}.xls`, size: half }),
    );
    expect(checkUploadBatch(files).ok).toBe(true);
  });
});

describe("checkWorkbookSignature", () => {
  it("accepts OLE2 bytes behind a .xls name", () => {
    expect(checkWorkbookSignature("日考勤数据.xls", bytesOf(OLE2_MAGIC))).toEqual({ ok: true });
  });

  it("accepts ZIP bytes behind a .xlsx name", () => {
    expect(checkWorkbookSignature("plan.xlsx", bytesOf(ZIP_MAGIC)).ok).toBe(true);
  });

  it("names the real format when an .xlsx is renamed to .xls", () => {
    // The case the whole check exists for. Without it these bytes reach the parser and
    // fail as "unreadable workbook" - a message that sends the operator hunting for
    // corruption instead of fixing a rename.
    const message = messageOf(checkWorkbookSignature("日考勤数据.xls", bytesOf(ZIP_MAGIC)));
    expect(message).toContain(".xlsx");
    expect(message).toContain("扩展名");
  });

  it("names the real format in the other direction too", () => {
    const message = messageOf(checkWorkbookSignature("plan.xlsx", bytesOf(OLE2_MAGIC)));
    expect(message).toContain(".xls");
  });

  it("reports 'neither format' when the bytes match no signature", () => {
    // A CSV saved with an .xls extension. There is no other format to point at, so the
    // message must not invent one.
    const csv = new TextEncoder().encode("工号,姓名,出勤日期\n1001,张三,2026-07-01\n");
    const message = messageOf(checkWorkbookSignature("考勤.xls", csv));
    expect(message).toContain("既不是");
    expect(message).not.toContain("扩展名被改成");
  });

  it("refuses bytes shorter than the signature instead of reading past the end", () => {
    const message = messageOf(checkWorkbookSignature("考勤.xls", new Uint8Array([0xd0, 0xcf])));
    expect(message).toContain("过短");
  });

  it("refuses an unrecognised extension without looking at the bytes", () => {
    expect(messageOf(checkWorkbookSignature("考勤.txt", bytesOf(OLE2_MAGIC)))).toContain(".csv");
  });

  it("accepts plain text behind a .csv name (D-221)", () => {
    // A CSV has no signature to match, so the only thing the guard can prove is the
    // absence of a workbook container. Whether this text really is an attendance report
    // is decided further in, by the header check in csv.ts.
    const csv = new TextEncoder().encode("工号,姓名,出勤日期\r\n100028,张三,2026-08-25\r\n");
    expect(checkWorkbookSignature("日考勤数据 1.csv", csv)).toEqual({ ok: true });
  });

  it("accepts a .csv too short to hold any signature", () => {
    // The length floor belongs to the workbook branch only. An almost-empty CSV is a file
    // problem, not a container problem, and csv.ts reports it as "文件是空的".
    expect(checkWorkbookSignature("日考勤数据.csv", new Uint8Array([0x31])).ok).toBe(true);
  });

  it("refuses an .xls renamed to .csv and names the real format", () => {
    // The inverted check. Without it these bytes reach the CSV decoder and come back as
    // an encoding complaint - true of any binary, and useless to act on.
    const message = messageOf(checkWorkbookSignature("日考勤数据.csv", bytesOf(OLE2_MAGIC)));
    expect(message).toContain(".xls");
    expect(message).toContain("扩展名");
  });

  it("refuses an .xlsx renamed to .csv as well", () => {
    expect(messageOf(checkWorkbookSignature("考勤.csv", bytesOf(ZIP_MAGIC)))).toContain(".xlsx");
  });
});

describe("sanitiseFileMtime", () => {
  const now = new Date(Date.UTC(2026, 7, 11, 8, 0, 0));

  it("keeps a plausible timestamp", () => {
    const mtime = Date.UTC(2026, 7, 10, 22, 30, 0);
    expect(sanitiseFileMtime(mtime, now)?.getTime()).toBe(mtime);
  });

  it("rejects 0 - the platform reported no timestamp at all", () => {
    expect(sanitiseFileMtime(0, now)).toBeNull();
  });

  it("rejects NaN, which File.lastModified can be", () => {
    expect(sanitiseFileMtime(Number.NaN, now)).toBeNull();
  });

  it("rejects a pre-2020 timestamp rather than storing a 1970 provenance date", () => {
    // The system covers FY2026 onward, so this is a clock fault or a filesystem that lost
    // the attribute. Storing it would make /actuals's 文件时间 column read as though HR
    // published the file decades ago - a plausible wrong date, which is worse than null.
    expect(sanitiseFileMtime(Date.UTC(1970, 0, 2), now)).toBeNull();
    expect(sanitiseFileMtime(Date.UTC(2019, 11, 31), now)).toBeNull();
  });

  it("accepts 2020-01-01 exactly - the floor itself is trusted", () => {
    expect(sanitiseFileMtime(Date.UTC(2020, 0, 1), now)).not.toBeNull();
  });

  it("tolerates a browser clock up to a day ahead but rejects further", () => {
    // lastModified is client-supplied, so a workstation with a skewed clock is ordinary.
    // A day of slack absorbs that; a week ahead is bad data.
    const oneDay = 24 * 60 * 60 * 1000;
    expect(sanitiseFileMtime(now.getTime() + oneDay, now)).not.toBeNull();
    expect(sanitiseFileMtime(now.getTime() + 7 * oneDay, now)).toBeNull();
  });
});
