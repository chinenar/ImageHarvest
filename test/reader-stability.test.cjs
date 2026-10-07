'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {readerDocumentKey,sameReaderDocument}=require('../src/reader-document.cjs');
const chapter='https://mangadex.org/chapter/dc9ef328-5b11-4f93-8322-1b9b077441ab';
test('MangaDex page position is not a new chapter',()=>{
 for(const suffix of ['', '/', '/1','/22','/999#page'])assert.equal(readerDocumentKey(chapter+suffix),readerDocumentKey(chapter));
 assert.equal(sameReaderDocument(chapter+'/1',chapter+'/5'),true);
});
test('different chapters, queries, origins and unrecognized routes retain separate identities',()=>{
 for(const other of [chapter.replace('dc9ef328','ab9ef328')+'/1',chapter+'?language=ja',chapter.replace('https:','http:'),chapter+'/comments',chapter.replace('mangadex.org','mangadex.org.example.com')])assert.notEqual(readerDocumentKey(other),readerDocumentKey(chapter));
 assert.equal(sameReaderDocument('https://example.com/chapter/1','https://example.com/chapter/2'),false);
 assert.equal(sameReaderDocument('https://example.com/#/chapter/1','https://example.com/#/chapter/2'),false);
});
test('serialized document-key function has the same behavior without Node dependencies',()=>{
 const serialized=Function('return ('+readerDocumentKey.toString()+')')();
 for(const url of [chapter+'/3',chapter+'/1?quality=data',chapter.replace('dc9ef328','ab9ef328')+'/1','https://example.com/#next'])assert.equal(serialized(url),readerDocumentKey(url));
});
