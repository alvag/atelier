import { crc32, deflateSync } from "node:zlib";

/** A one-pixel RGBA PNG generated in memory, without loading the native codec. */
export function png(red = 255): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const size = Buffer.alloc(4);
		size.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body));
		return Buffer.concat([size, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.from([0, red, 0, 0, 255]))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
