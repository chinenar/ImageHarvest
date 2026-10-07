'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseTextModel,
  selectMangaPages,
  parseJsonContent,
  HarvestTranslationClient,
  GoogleTranslateClient
} = require('../src/harvest-translate.cjs');

test('selectMangaPages prefers reader content, filters chrome and preserves visual order', () => {
  const items = [
    { url:'https://x/page2.jpg', source:'img', width:900, height:1300, top:1400, left:0, filterHints:{ mainKind:'reader', contentScore:92 } },
    { url:'https://x/logo.png', source:'img', width:500, height:500, top:0, left:0, filterHints:{ mainKind:'reader', chrome:true, category:'icon' } },
    { url:'https://x/page1.jpg', source:'img', width:900, height:1300, top:20, left:0, filterHints:{ mainKind:'reader', contentScore:92 } },
    { url:'https://x/main.jpg', source:'img', width:1000, height:1000, top:10, left:0, filterHints:{ mainKind:'main', contentScore:68 } },
    { url:'https://x/page1.jpg', source:'img', width:900, height:1300, top:30, left:0, filterHints:{ mainKind:'reader', contentScore:92 } }
  ];
  assert.deepEqual(selectMangaPages(items).map(x => x.url), ['https://x/page1.jpg','https://x/page2.jpg']);
});

test('chooseTextModel ignores image/embedding models and prefers capable text model', () => {
  const models = [
    { id:'qwen-image-2.1' },
    { id:'text-embedding-nomic' },
    { id:'llama-3.3-70b-instruct' },
    { id:'qwen3.8-27b-instruct' }
  ];
  assert.equal(chooseTextModel(models), 'qwen3.8-27b-instruct');
  assert.equal(chooseTextModel([
    { id:'qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp' },
    { id:'qwen3.8-27b-uncensored' }
  ]), 'qwen3.8-27b-uncensored');
});

test('parseJsonContent accepts fenced JSON', () => {
  assert.deepEqual(parseJsonContent('```json\n{"items":[{"id":"1","translation":"สวัสดี"}]}\n```'), {
    items:[{ id:'1', translation:'สวัสดี' }]
  });
});

test('HarvestTranslationClient waits for native LM Studio model load and warm-up before translation', async () => {
  let nativePolls=0,warmCalls=0,loaded=false;
  const fakeFetch=async(url,options={})=>{
    if(url.endsWith('/api/v1/models')){
      nativePolls++;
      return new Response(JSON.stringify({models:[{type:'llm',key:'qwen3.8-27b-uncensored',loaded_instances:loaded?[{id:'qwen3.8-27b-uncensored',config:{parallel:4}}]:[]}]}),{status:200,headers:{'content-type':'application/json'}});
    }
    if(url.endsWith('/api/v1/chat')){
      warmCalls++;
      if(!loaded){loaded=true;return new Response(JSON.stringify({error:{message:'Model does not exist.'}}),{status:404,headers:{'content-type':'application/json'}});}
      return new Response(JSON.stringify({model_instance_id:'qwen3.8-27b-uncensored',output:[{type:'message',content:'READY'}]}),{status:200,headers:{'content-type':'application/json'}});
    }
    if(url.endsWith('/v1/models'))return new Response(JSON.stringify({data:[{id:'qwen3.8-27b-uncensored'}]}),{status:200,headers:{'content-type':'application/json'}});
    throw new Error('unexpected '+url);
  };
  const client=new HarvestTranslationClient({baseUrl:'http://127.0.0.1:1234',fetchImpl:fakeFetch});
  const state=await client.ensureModelReady('qwen3.8-27b-uncensored',{timeoutMs:30000,pollMs:1});
  assert.equal(state.ready,true);assert.equal(state.native,true);assert.equal(state.parallel,4);assert.ok(nativePolls>=2);assert.ok(warmCalls>=2);
});

test('HarvestTranslationClient uses OpenAI-compatible models and chat endpoints', async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data:[{ id:'qwen3.8-27b-instruct' }] }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    return new Response(JSON.stringify({ choices:[{ message:{ content:'สวัสดี' } }] }), { status:200, headers:{ 'content-type':'application/json' } });
  };
  const client = new HarvestTranslationClient({ baseUrl:'http://127.0.0.1:1234/', fetchImpl:fakeFetch });
  const result = await client.probe({ sample:true });
  assert.equal(result.model, 'qwen3.8-27b-instruct');
  assert.equal(result.sample, 'สวัสดี');
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/models');
  assert.equal(calls[1].url, 'http://127.0.0.1:1234/v1/chat/completions');
});


test('GoogleTranslateClient calls official Cloud Translation v2 endpoint and preserves region ids', async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    const request = JSON.parse(options.body);
    assert.deepEqual(request.q, ['Hello','World']);
    assert.equal(request.target, 'th');
    assert.equal(request.source, 'en');
    return new Response(JSON.stringify({
      data:{ translations:[
        { translatedText:'สวัสดี', detectedSourceLanguage:'en' },
        { translatedText:'โลก', detectedSourceLanguage:'en' }
      ] }
    }), { status:200, headers:{ 'content-type':'application/json' } });
  };
  const client = new GoogleTranslateClient({ apiKey:'AIza-test-key-12345678901234567890', fetchImpl:fakeFetch });
  const result = await client.translateRegions([
    { id:'a', text:'Hello' },
    { id:'b', text:'World' }
  ], { sourceLanguage:'en', targetLanguage:'th' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/translation\.googleapis\.com\/language\/translate\/v2\?key=/);
  assert.deepEqual(result, [
    { id:'a', translation:'สวัสดี', detectedSourceLanguage:'en' },
    { id:'b', translation:'โลก', detectedSourceLanguage:'en' }
  ]);
});

test('GoogleTranslateClient omits source when language detection is automatic', async () => {
  const fakeFetch = async (_url, options = {}) => {
    const request = JSON.parse(options.body);
    assert.equal('source' in request, false);
    return new Response(JSON.stringify({
      data:{ translations:[{ translatedText:'สวัสดี', detectedSourceLanguage:'en' }] }
    }), { status:200, headers:{ 'content-type':'application/json' } });
  };
  const client = new GoogleTranslateClient({ apiKey:'AIza-test-key-12345678901234567890', fetchImpl:fakeFetch });
  const result = await client.translateRegions([{ id:'1', text:'Hello' }], { sourceLanguage:'auto', targetLanguage:'th' });
  assert.equal(result[0].translation, 'สวัสดี');
  assert.equal(result[0].detectedSourceLanguage, 'en');
});


test('GoogleTranslateWebPool runs up to four hidden translation workers concurrently', async () => {
  const { GoogleTranslateWebPool } = require('../src/google-translate-web.cjs');
  let active = 0, maxActive = 0, sequence = 0;
  const pool = new GoogleTranslateWebPool({
    size:4,
    clientFactory:index => ({
      async translate(regions) {
        active++;
        maxActive = Math.max(maxActive, active);
        const id = ++sequence;
        await new Promise(resolve => setTimeout(resolve, 40));
        active--;
        return regions.map(region => ({ id:String(region.id), translation:'worker-'+index+'-'+id }));
      },
      close() {}
    })
  });
  try {
    const jobs = Array.from({length:8}, (_, index) =>
      pool.translate([{ id:'r'+index, text:'hello '+index }], {})
    );
    const results = await Promise.all(jobs);
    assert.equal(results.length, 8);
    assert.equal(maxActive, 4);
    assert.ok(results.every(rows => rows[0].translation.startsWith('worker-')));
  } finally {
    pool.close();
  }
});


test('page task scheduler runs 16 pages as four concurrent tasks of four pages', async () => {
  const { runPageTaskGroups } = require('../src/page-task-pool.cjs');
  const starts = [];
  const seen = [];
  let active = 0, maxActive = 0;
  const pages = Array.from({length:16}, (_, index) => index + 1);
  const result = await runPageTaskGroups(pages, {
    taskSize:4,
    concurrency:4,
    onTaskStart:({taskId,pages}) => starts.push({taskId,pages:[...pages]}),
    handlePage:async(page,{taskId}) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      seen.push({page,taskId});
      active--;
    }
  });
  assert.equal(result.tasks,4);
  assert.equal(result.groups,4);
  assert.equal(maxActive,4);
  assert.deepEqual(starts.map(row => row.pages),[
    [1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16]
  ]);
  assert.deepEqual([...seen.map(row=>row.page)].sort((a,b)=>a-b),pages);
});


test('HarvestTranslationClient allows four local-model requests in flight together', async () => {
  let active = 0, maxActive = 0;
  const fakeFetch = async (_url, options = {}) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 35));
    active--;
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.messages.at(-1).content);
    return new Response(JSON.stringify({
      choices:[{message:{content:JSON.stringify({items:input.items.map(item=>({id:item.id,translation:'ไทย'}))})}}]
    }), {status:200,headers:{'content-type':'application/json'}});
  };
  const client = new HarvestTranslationClient({baseUrl:'http://127.0.0.1:1234',fetchImpl:fakeFetch});
  const jobs = Array.from({length:4}, (_,index) =>
    client.translateRegions([{id:'r'+index,text:'Hello '+index}],{model:'qwen-text-mock',targetLanguage:'Thai'})
  );
  const result = await Promise.all(jobs);
  assert.equal(maxActive,4);
  assert.ok(result.every(rows=>rows[0].translation==='ไทย'));
});
