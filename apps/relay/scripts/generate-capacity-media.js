// Generates valid, non-sensitive benchmark files under ignored target output.
import fs from "node:fs";
import path from "node:path";
import { randomFillSync } from "node:crypto";
import { deflateSync } from "node:zlib";
const directory=path.resolve(new URL("../../teacher/src-tauri/target/phase16f-smoke/",import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,"$1"));
fs.mkdirSync(directory,{recursive:true});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function pngChunk(type,body){const tag=Buffer.from(type),chunk=Buffer.alloc(body.length+12);chunk.writeUInt32BE(body.length);tag.copy(chunk,4);body.copy(chunk,8);chunk.writeUInt32BE(crc32(Buffer.concat([tag,body])),body.length+8);return chunk;}
const width=724,height=723,row=width*4+1;
const pixels=Buffer.alloc(row*height);randomFillSync(pixels);
for(let y=0;y<height;y++)pixels[y*row]=0;
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk("IHDR",ihdr),pngChunk("IDAT",deflateSync(pixels,{level:0})),pngChunk("IEND",Buffer.alloc(0))]);
fs.writeFileSync(path.join(directory,"image.png"),png);
const total=100*1024*1024;
const objects=[
 "<< /Type /Catalog /Pages 2 0 R >>",
 "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
 "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
 "<< /Length 80 >>\nstream\nBT /F1 18 Tf 72 720 Td (Synthetic 100 MiB PDF benchmark) Tj ET\nendstream",
 "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
const pageText="BT /F1 18 Tf 72 720 Td (Synthetic 100 MiB PDF benchmark) Tj ET\n";
objects[3]=`<< /Length ${Buffer.byteLength(pageText)} >>\nstream\n${pageText}endstream`;
let prefix="%PDF-1.4\n";const offsets=[0];
for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(prefix));prefix+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
offsets.push(Buffer.byteLength(prefix));let padding=total-1024;
let finalPrefix,finalSuffix;
for(let i=0;i<4;i++){
 finalPrefix=prefix+`6 0 obj\n<< /Length ${padding} >>\nstream\n`;
 const end="\nendstream\nendobj\n";const xref=Buffer.byteLength(finalPrefix)+padding+Buffer.byteLength(end);
 finalSuffix=end+"xref\n0 7\n0000000000 65535 f \n"+offsets.slice(1).map(v=>String(v).padStart(10,"0")+" 00000 n \n").join("")+`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 padding=total-Buffer.byteLength(finalPrefix)-Buffer.byteLength(finalSuffix);
}
const fd=fs.openSync(path.join(directory,"document.pdf"),"w");
fs.writeSync(fd,finalPrefix);const block=Buffer.alloc(65536,97);
for(let remaining=padding;remaining>0;remaining-=Math.min(remaining,block.length))fs.writeSync(fd,block,0,Math.min(remaining,block.length));
fs.writeSync(fd,finalSuffix);fs.closeSync(fd);
if(png.length>20*1024*1024||fs.statSync(path.join(directory,"document.pdf")).size!==total)throw new Error("Fixture size is invalid");
console.log(JSON.stringify({imageBytes:png.length,pdfBytes:total,nonSensitive:true}));
