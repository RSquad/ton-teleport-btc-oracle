import { Builder, Cell, beginCell } from "@ton/core";

export const splitBufferToCells = (buf: Buffer, splitSize?: number): Cell => {
  splitSize = splitSize ?? 1;
  splitSize = Math.min(127, splitSize);
  const cellCapacity = Math.floor(127 / splitSize) * splitSize;
  const cellsCount = Math.ceil(buf.length / cellCapacity);
  let offset = 0;
  const cells: Builder[] = [];
  for (let i = 0; i < cellsCount - 1; i++) {
    cells.push(
      beginCell().storeBuffer(buf.subarray(offset, offset + cellCapacity)),
    );
    offset += cellCapacity;
  }
  cells.push(beginCell().storeBuffer(buf.subarray(offset)));
  for (let i = cells.length - 1; i >= 1; i--) {
    cells[i - 1].storeRef(cells[i].endCell());
  }
  return cells[0].endCell();
};

export const writeCellsToBuffer = (cell: Cell): Buffer => {
  let cellSlice = cell.beginParse();
  const cellBufs: Buffer[] = [
    cellSlice.loadBuffer(cellSlice.remainingBits / 8),
  ];
  while (cellSlice.remainingRefs) {
    cellSlice = cellSlice.loadRef().beginParse();
    cellBufs.push(cellSlice.loadBuffer(cellSlice.remainingBits / 8));
  }
  return Buffer.concat(cellBufs);
};
