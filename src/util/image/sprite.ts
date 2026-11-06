import * as vscode from "vscode";
import { PNG } from "pngjs";
import { NumberPosition } from "../common";
import { pngToPng } from "./converter";

export class Image {
	private cachedUri: string | undefined = undefined;
	constructor(
		readonly pngBuffer: Buffer,
		readonly width: number,
		readonly height: number,
		readonly path: vscode.Uri,
	) {}

	// Computed once and reused: the base64 data URI is ~33% larger than the PNG buffer, but the
	// GFX preview re-renders every sprite on each edit, so re-encoding the unchanged ones was the
	// hot path (per keystroke for a texture atlas). Memoizing on the instance is safe because Image
	// is immutable and the image cache keys instances by file path + change token, so a texture that
	// changes produces a fresh instance with a fresh buffer rather than a stale URI. Memory stays
	// bounded by the image cache's own cap.
	public get uri(): string {
		if (this.cachedUri === undefined) {
			this.cachedUri = toDataUrl(this.pngBuffer);
		}
		return this.cachedUri;
	}
}

export class Sprite {
	private readonly cachedFrames: Array<Image | undefined> = [];
	constructor(
		readonly id: string,
		readonly image: Image,
		readonly noOfFrames: number,
	) {}

	// Cuts one frame off the strip the first time it is asked for. The strip is decoded again for
	// each new frame rather than kept: decoded, it outweighs every frame cut from it.
	public frame(index: number): Image | undefined {
		if (!Number.isInteger(index) || index < 0 || index >= this.noOfFrames) {
			return undefined;
		}

		if (this.noOfFrames === 1) {
			return this.image;
		}

		const cached = this.cachedFrames[index];
		if (cached) {
			return cached;
		}

		const png = pngRead(this.image.pngBuffer);
		const frame = extractImageFromPng(png, index * this.width, 0, this.width, png.height, this.image.path);
		this.cachedFrames[index] = frame;
		return frame;
	}

	public get width(): number {
		return this.image.width / this.noOfFrames;
	}

	public get height(): number {
		return this.image.height;
	}
}

export class CorneredTileSprite extends Sprite {
	private cachedTiles: Record<number, Image[]> = {};

	constructor(
		id: string,
		image: Image,
		noOfFrames: number,
		readonly size: NumberPosition,
		readonly borderSize: NumberPosition,
	) {
		super(id, image, noOfFrames);
	}

	public getTiles(frameId: number = 0): Image[] {
		if (frameId >= this.noOfFrames) {
			frameId = 0;
		}

		const cached = this.cachedTiles[frameId];
		if (cached) {
			return cached;
		}

		const frame = this.frame(frameId);
		if (frame === undefined) {
			return [];
		}
		const sizeX = frame.width;
		const sizeY = frame.height;
		const backPng = pngRead(frame.pngBuffer);

		let borderX = this.borderSize.x;
		let borderY = this.borderSize.y;
		if (borderX * 2 >= sizeX) {
			borderX = Math.max(0, Math.floor(sizeX / 2 - 1));
		}
		if (borderY * 2 >= sizeY) {
			borderY = Math.max(0, Math.floor(sizeY / 2 - 1));
		}

		const path = this.image.path;
		const xPos = [0, borderX, sizeX - borderX, sizeX];
		const yPos = [0, borderY, sizeY - borderY, sizeY];
		const tiles: Image[] = [];
		for (let y = 0; y < 3; y++) {
			for (let x = 0; x < 3; x++) {
				tiles.push(
					extractImageFromPng(
						backPng,
						xPos[x],
						yPos[y],
						xPos[x + 1] - xPos[x],
						yPos[y + 1] - yPos[y],
						path,
					),
				);
			}
		}

		this.cachedTiles[frameId] = tiles;
		return tiles;
	}
}

function toDataUrl(buffer: Buffer): string {
	return "data:image/png;base64," + buffer.toString("base64");
}

function extractImageFromPng(
	png: PNG,
	x: number,
	y: number,
	w: number,
	h: number,
	path: vscode.Uri,
): Image {
	const resultPng = new PNG({ width: w, height: h });
	if (w > 0 && h > 0) {
		png.bitblt(resultPng, x, y, w, h, 0, 0);
	}
	return new Image(PNG.sync.write(resultPng), w, h, path);
}

function pngRead(buffer: Buffer): PNG {
	// Sliced sprite frames inherit the same decode limits as a full texture.
	const result = pngToPng(buffer);
	Object.setPrototypeOf(result, PNG.prototype);
	return result;
}
