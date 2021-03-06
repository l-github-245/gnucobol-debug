/**
 * Ported from
 * https://github.com/mitchhentges/lcov-rs/wiki/File-format
 * https://github.com/eclipse/linuxtools/tree/master/gcov
 * Eclipse Public License 2.0
 */
import {GcdaRecordsParser} from './parser.gcda';
import {GcnoRecordsParser} from './parser.gcno';
import * as fs from "fs";

export class Arc {
    readonly VCOV_ARC_ON_TREE: number = (1 << 0);
    readonly VCOV_ARC_FAKE: number = (1 << 1);
    readonly VCOV_ARC_FALLTHROUGH: number = (1 << 2);
    srcBlock: Block;
    dstBlock: Block;
    isOnTree: boolean;
    count: number = 0;
    isValid: boolean = false;

    constructor(srcBlockIndex: number, dstBlockIndice: number, flag: number, otherArcParams: Block[]) {
        this.dstBlock = otherArcParams[dstBlockIndice];
        this.srcBlock = otherArcParams[srcBlockIndex];
        if ((flag & this.VCOV_ARC_ON_TREE) != 0) {
            this.isOnTree = true;
        } else if ((flag & this.VCOV_ARC_FAKE) != 0) {
            this.isOnTree = false;
        } else if ((flag & this.VCOV_ARC_FALLTHROUGH) != 0) {
            this.isOnTree = false;
        } else {
            this.isOnTree = false;
        }
    }
}

export class Block {
    entryArcs: Arc[] = [];
    exitArcs: Arc[] = [];
    lineNumbers: number[] = [];
    successCount: number = 0;
    predictionsCount: number = 0;
    count: number = 0;
    sourceIndex: number = 0;
    isValidChain: boolean = false;
    isInvalidChain: boolean = false;
    countValid: boolean = false;
}

export interface Coverage {
    fileC: string;
    lineC: number;
    hasExecuted: boolean;
}

export class Line {
    exists: boolean = false;
    count: number = 0;
    blocks: Set<Block> = new Set<Block>();
}

export class SourceFile {
    name: string;
    index: number;
    lines: Line[] = [];
    functions: Set<GcnoFunction> = new Set<GcnoFunction>();
    linesCount: number = 1;

    constructor(name: string, index: number) {
        this.name = name;
        this.index = index;
    }
}

export interface IRecordParser {
    parse(stream: DataInput): void;
}

export class DataInput {
    private isBigEndian = true;
    private offset = 0;
    private buffer: Buffer;

    constructor(buffer: Buffer) {
        this.buffer = buffer;
    }

    public readString(): string {
        const length = this.readInt() << 2;
        this.offset += length;
        return this.buffer.subarray(this.offset - length, this.offset).toString('utf8').replace(/\0/g, '');
    }

    public readInt(): number {
        this.offset += 4;
        return this.isBigEndian ?
            this.buffer.subarray(this.offset - 4, this.offset).readUInt32BE() :
            this.buffer.subarray(this.offset - 4, this.offset).readUInt32LE();
    }

    public readLong(): number {
        this.offset += 8;
        return Number(
            this.isBigEndian ?
                this.buffer.subarray(this.offset - 8, this.offset).readBigUInt64BE() :
                this.buffer.subarray(this.offset - 8, this.offset).readBigUInt64LE()
        );
    }

    public setBigEndian(): void {
        this.isBigEndian = true;
    }

    public setLittleEndian(): void {
        this.isBigEndian = false;
    }
}

export class GcnoFunction {
    ident: number;
    checksum: number;
    firstLineNumber: number;
    srcFile: string;
    functionBlocks: Block[] = [];

    constructor(ident: number, checksum: number, srcFile: string, firstLineNumber: number) {
        this.ident = ident;
        this.checksum = checksum;
        this.srcFile = srcFile;
        this.firstLineNumber = firstLineNumber;
    }

    public addLineCounts(sourceFiles: SourceFile[]): void {
        const linesToCalculate: Set<Line> = new Set<Line>();
        for (const block of this.functionBlocks) {
            let sourceFile: SourceFile = null;
            for (const file of sourceFiles) {
                if (file.index == block.sourceIndex) {
                    sourceFile = file;
                    break;
                }
            }
            for (const lineNumber of block.lineNumbers) {
                if (sourceFile != null && lineNumber < sourceFile.lines.length) {
                    const line = sourceFile.lines[lineNumber];
                    line.exists = true;
                    if (line.blocks.size > 1) {
                        linesToCalculate.add(line);
                        line.count = 1;
                    } else {
                        line.count += block.count;
                    }
                }
            }
        }
        for (const line of linesToCalculate) {
            let count = 0;
            for (const block of line.blocks) {
                for (const arc of block.entryArcs) {
                    if (!line.blocks.has(arc.srcBlock)) {
                        count += arc.count;
                    }
                }
            }
            line.count = count;
        }
    }

    public solveGraphFunction(): void {
        const validBlocks: Block[] = [];
        const invalidBlocks: Block[] = [];

        if (this.functionBlocks.length >= 2) {
            if (this.functionBlocks[0].predictionsCount == 0) {
                this.functionBlocks[0].predictionsCount = 50000;
            }
            if (this.functionBlocks[this.functionBlocks.length - 1].successCount == 0) {
                this.functionBlocks[this.functionBlocks.length - 1].successCount = 50000;
            }
        }

        for (const b of this.functionBlocks) {
            b.isInvalidChain = true;
            invalidBlocks.push(b);
        }

        while (validBlocks.length > 0 || invalidBlocks.length > 0) {
            if (invalidBlocks.length > 0) {
                for (let i = invalidBlocks.length - 1; i >= 0; i--) {
                    const invalidBlock: Block = invalidBlocks[i];
                    let total = 0;
                    invalidBlocks.pop();
                    invalidBlock.isInvalidChain = false;
                    if (invalidBlock.predictionsCount != 0 && invalidBlock.successCount != 0)
                        continue;

                    if (invalidBlock.successCount == 0) {
                        const exitArcs: Arc[] = invalidBlock.exitArcs;
                        for (const arc of exitArcs) {
                            total += arc.count;
                        }
                    }
                    if (invalidBlock.predictionsCount == 0 && total == 0) {
                        const entryArcs: Arc[] = invalidBlock.entryArcs;
                        for (const arc of entryArcs) {
                            total += arc.count;
                        }
                    }

                    invalidBlock.count = total;
                    invalidBlock.countValid = true;
                    invalidBlock.isValidChain = true;
                    validBlocks.push(invalidBlock);
                }
            }
            while (validBlocks.length > 0) {
                const last = validBlocks.length - 1;
                const vb: Block = validBlocks[last];
                let invarc: Arc = null;
                let total = 0;
                validBlocks.pop();
                vb.isValidChain = false;
                if (vb.successCount === 1) {
                    let dstBlock: Block;
                    total = vb.count;
                    for (const extAr of vb.exitArcs) {
                        total -= extAr.count;
                        if (extAr.isValid == false) {
                            invarc = extAr;
                        }
                    }
                    dstBlock = invarc.dstBlock;
                    invarc.isValid = true;
                    invarc.count = total;
                    vb.successCount--;
                    dstBlock.predictionsCount--;

                    if (dstBlock.countValid) {
                        if (dstBlock.predictionsCount == 1 && !dstBlock.isValidChain) {
                            dstBlock.isValidChain = true;
                            validBlocks.push(dstBlock);
                        }
                    } else {
                        if (dstBlock.predictionsCount == 0 && !dstBlock.isInvalidChain) {
                            dstBlock.isInvalidChain = true;
                            invalidBlocks.push(dstBlock);
                        }
                    }
                }

                if (vb.predictionsCount == 1) {
                    let blcksrc: Block;
                    total = vb.count;
                    invarc = null;

                    for (const entrAr of vb.entryArcs) {
                        total -= entrAr.count;
                        if (!entrAr.isValid) {
                            invarc = entrAr;
                        }
                    }

                    blcksrc = invarc.srcBlock;
                    invarc.isValid = true;
                    invarc.count = total;
                    vb.predictionsCount--;
                    blcksrc.successCount--;

                    if (blcksrc.countValid) {
                        if (blcksrc.successCount == 1 && !blcksrc.isInvalidChain) {
                            blcksrc.isValidChain = true;
                            validBlocks.push(blcksrc);
                        }
                    } else if (blcksrc.successCount == 0 && !blcksrc.isInvalidChain) {
                        blcksrc.isInvalidChain = true;
                        invalidBlocks.push(blcksrc);
                    }
                }
            }
        }
    }
}

export function parseGcov(gcovFiles: string[]): Coverage[] {
    let gcdaRecordsParser: GcdaRecordsParser;
    let stream: DataInput;
    const sourceFiles: SourceFile[] = [];
    const gcnoFunctions: GcnoFunction[] = [];
    const sourceMap: Map<string, SourceFile> = new Map<string, SourceFile>();

    for (const gcovFile of gcovFiles) {
        // parse GCNO
        let file = gcovFile + '.gcno';
        if (!fs.existsSync(file)) {
            throw Error("File not found: " + file);
        }
        stream = new DataInput(fs.readFileSync(file));
        const gcnoRecordsParser = new GcnoRecordsParser(sourceMap, sourceFiles);
        gcnoRecordsParser.parse(stream);

        // add new functions
        for (const f of gcnoRecordsParser.getFunctions()) {
            gcnoFunctions.push(f);
        }

        // parse GCDA
        file = gcovFile + '.gcda';
        if (!fs.existsSync(file)) {
            throw Error("File not found: " + file);
        }
        stream = new DataInput(fs.readFileSync(file));
        if (gcnoRecordsParser.getFunctions().length === 0) {
            throw new Error("Parsing error");
        }
        gcdaRecordsParser = new GcdaRecordsParser(gcnoRecordsParser.getFunctions());
        gcdaRecordsParser.parse(stream);
    }

    const coverages: Map<string, Coverage> = new Map<string, Coverage>();
    for (const sourceFile of sourceFiles) {
        const linesCount = sourceFile.linesCount;
        for (let j = 0; j < linesCount; j++) {
            sourceFile.lines.push(new Line());
        }
        for (const gcnoFunction of sourceFile.functions) {
            for (const block of gcnoFunction.functionBlocks) {
                for (const lineno of block.lineNumbers) {
                    const line: Line = sourceFile.lines[lineno];
                    line.blocks.add(block);
                }
            }
            gcnoFunction.solveGraphFunction();
            gcnoFunction.addLineCounts(sourceFiles);
        }

        // coverage
        for (const line of sourceFile.lines) {
            if (!line.exists) {
                continue;
            }
            for (const block of line.blocks) {
                for (const lineNum of block.lineNumbers) {
                    coverages.set(`${sourceFile.name}${lineNum}`, {
                        fileC: sourceFile.name,
                        lineC: lineNum,
                        hasExecuted: line.count > 0

                    } as Coverage);
                }
            }
        }
    }
    return Array.from(coverages.values());
}
