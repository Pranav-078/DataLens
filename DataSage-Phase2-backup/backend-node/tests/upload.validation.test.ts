import { describe, it, expect } from "vitest";
import { ErrorCode } from "../src/errors/errorCodes.js";
import { AppError } from "../src/errors/AppError.js";
import {
  validateUploadBatch,
  checkPathSafety,
  checkFileCount,
  checkFileSize,
  type UploadFileInput,
} from "../src/modules/uploads/upload.validator.js";
import { normalizeTableName } from "../src/modules/uploads/tableName.js";

function csv(content: string): Buffer {
  return Buffer.from(content, "utf8");
}

function file(name: string, content: string | Buffer): UploadFileInput {
  return { originalFilename: name, buffer: typeof content === "string" ? csv(content) : content };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected an AppError with code ${code}, but no error was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
  }
}

const VALID_CUSTOMERS = "customer_id,name,email\n1,Ann,ann@example.com\n2,Bo,bo@example.com\n";
const VALID_ORDERS = "order_id,customer_id,total\n1,1,20.00\n2,2,35.50\n";

describe("upload validation — happy path", () => {
  it("accepts a well-formed multi-file upload and returns table names, columns, row counts", async () => {
    const result = await validateUploadBatch([
      file("customers.csv", VALID_CUSTOMERS),
      file("orders.csv", VALID_ORDERS),
    ]);

    expect(result).toHaveLength(2);
    const [customers, orders] = result;
    expect(customers).toMatchObject({
      originalFilename: "customers.csv",
      tableName: "customers",
      rowCount: 2,
      columnNames: ["customer_id", "name", "email"],
    });
    expect(customers?.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(orders).toMatchObject({ tableName: "orders", rowCount: 2 });
  });
});

describe("upload validation — file type", () => {
  it("rejects a filename without a .csv extension", async () => {
    await expectCode(
      validateUploadBatch([file("customers.txt", VALID_CUSTOMERS)]),
      ErrorCode.UNSUPPORTED_FILE_TYPE
    );
  });

  it("rejects a file whose magic bytes indicate a binary format despite a .csv name", async () => {
    // A complete, valid PNG (1x1 transparent pixel) wearing a .csv extension.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const png = Buffer.from(pngBase64, "base64");
    await expectCode(validateUploadBatch([file("disguised.csv", png)]), ErrorCode.UNSUPPORTED_FILE_TYPE);
  });

  it("rejects a truncated binary file (magic bytes present, structure incomplete) instead of crashing", async () => {
    // Only the 8-byte PNG signature, no actual image data after it — this
    // is what previously caused an uncaught EndOfStreamError to escape
    // checkFileType instead of a clean AppError.
    const truncatedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await expectCode(
      validateUploadBatch([file("disguised.csv", truncatedPng)]),
      ErrorCode.UNSUPPORTED_FILE_TYPE
    );
  });
});

describe("upload validation — size and count", () => {
  it("rejects a zero-byte file", async () => {
    await expectCode(validateUploadBatch([file("empty.csv", Buffer.alloc(0))]), ErrorCode.EMPTY_FILE);
  });

  it("rejects a file over the configured size cap", () => {
    expect(() => checkFileSize("huge.csv", 100_000_000)).toThrowError(
      expect.objectContaining({ code: ErrorCode.FILE_TOO_LARGE })
    );
  });

  it("rejects more files than the per-upload limit", () => {
    expect(() => checkFileCount(11)).toThrowError(
      expect.objectContaining({ code: ErrorCode.TOO_MANY_FILES })
    );
  });
});

describe("upload validation — CSV structure", () => {
  it("rejects a header-only file (no data rows) as EMPTY_DATASET", async () => {
    await expectCode(
      validateUploadBatch([file("headeronly.csv", "a,b,c\n")]),
      ErrorCode.EMPTY_DATASET
    );
  });

  it("rejects a ragged row (wrong column count) as MALFORMED_CSV", async () => {
    await expectCode(
      validateUploadBatch([file("ragged.csv", "a,b,c\n1,2\n")]),
      ErrorCode.MALFORMED_CSV
    );
  });

  it("rejects unbalanced quotes as MALFORMED_CSV", async () => {
    await expectCode(
      validateUploadBatch([file("badquote.csv", 'a,b,c\n1,"unterminated,3\n')]),
      ErrorCode.MALFORMED_CSV
    );
  });

  it("rejects a header with a duplicate column name", async () => {
    await expectCode(
      validateUploadBatch([file("dupcol.csv", "a,b,a\n1,2,3\n")]),
      ErrorCode.DUPLICATE_COLUMN_NAME
    );
  });
});

describe("upload validation — encoding", () => {
  it("rejects a file with invalid UTF-8 byte sequences", async () => {
    // 0xFF 0xFE is not valid UTF-8 in this position.
    const invalidUtf8 = Buffer.concat([
      Buffer.from("a,b\n", "utf8"),
      Buffer.from([0xff, 0xfe, 0x31, 0x0a]),
    ]);
    await expectCode(validateUploadBatch([file("badenc.csv", invalidUtf8)]), ErrorCode.INVALID_ENCODING);
  });

  it("accepts plain ASCII, which is valid UTF-8", async () => {
    await expect(validateUploadBatch([file("ascii.csv", VALID_CUSTOMERS)])).resolves.toHaveLength(1);
  });
});

describe("upload validation — path safety", () => {
  it.each([
    ["../../etc/passwd.csv"],
    ["..\\..\\secrets.csv"],
    ["/etc/passwd.csv"],
    ["C:\\Windows\\win.csv"],
    ["a/b.csv"],
    ["a\0b.csv"],
  ])("rejects unsafe filename: %s", (name) => {
    expect(() => checkPathSafety(name)).toThrowError(
      expect.objectContaining({ code: ErrorCode.UNSAFE_FILE_PATH })
    );
  });

  it("accepts an ordinary safe filename", () => {
    expect(() => checkPathSafety("orders_v2.csv")).not.toThrow();
  });
});

describe("upload validation — batch-level collisions", () => {
  it("rejects two files with the identical filename in one upload", async () => {
    await expectCode(
      validateUploadBatch([file("orders.csv", VALID_ORDERS), file("orders.csv", VALID_ORDERS)]),
      ErrorCode.DUPLICATE_FILENAME
    );
  });

  it("rejects two differently-named files that normalize to the same table name", async () => {
    await expectCode(
      validateUploadBatch([
        file("Orders.csv", VALID_ORDERS),
        file("orders!!.csv", VALID_ORDERS),
      ]),
      ErrorCode.TABLE_NAME_COLLISION
    );
  });
});

describe("normalizeTableName", () => {
  it.each([
    ["Customer Orders (v2).CSV", "customer_orders_v2"],
    ["orders!!.csv", "orders"],
    ["Orders.csv", "orders"],
    ["***.csv", "table"], // fallback when normalization empties the name
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeTableName(input)).toBe(expected);
  });
});
