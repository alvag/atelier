/** A one-pixel RGB TIFF (uncompressed, little endian, one strip) generated in memory. */
export function tiff(): Buffer {
	const SHORT = 3;
	const LONG = 4;
	const entries: [tag: number, type: number, count: number, value: number][] = [
		[256, SHORT, 1, 1], // ImageWidth
		[257, SHORT, 1, 1], // ImageLength
		[258, SHORT, 3, 122], // BitsPerSample: at the offset after the IFD
		[259, SHORT, 1, 1], // Compression: none
		[262, SHORT, 1, 2], // PhotometricInterpretation: RGB
		[273, LONG, 1, 128], // StripOffsets: the pixel after the bit depths
		[277, SHORT, 1, 3], // SamplesPerPixel
		[278, SHORT, 1, 1], // RowsPerStrip
		[279, LONG, 1, 3], // StripByteCounts
	];
	const bytes = Buffer.alloc(131);
	bytes.write("II", 0, "ascii");
	bytes.writeUInt16LE(42, 2);
	bytes.writeUInt32LE(8, 4);
	bytes.writeUInt16LE(entries.length, 8);
	entries.forEach(([tag, type, count, value], index) => {
		const at = 10 + index * 12;
		bytes.writeUInt16LE(tag, at);
		bytes.writeUInt16LE(type, at + 2);
		bytes.writeUInt32LE(count, at + 4);
		if (type === SHORT && count === 1) bytes.writeUInt16LE(value, at + 8);
		else bytes.writeUInt32LE(value, at + 8);
	});
	bytes.writeUInt16LE(8, 122);
	bytes.writeUInt16LE(8, 124);
	bytes.writeUInt16LE(8, 126);
	bytes.set([255, 0, 0], 128);
	return bytes;
}
