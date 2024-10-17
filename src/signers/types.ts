import { Cell } from "@ton/core";

export interface ISigner {
  signCell(cell: Cell): Promise<Buffer>;
}
