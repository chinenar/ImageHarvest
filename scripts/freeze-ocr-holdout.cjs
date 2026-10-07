'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const references={
 'holdout-s2-p4-r0':'YOU...',"holdout-s2-p4-r2":"IT'S\nHIM...",'holdout-s2-p4-r4':'A DUEL\nCHALLENGE!!',
 'holdout-s3-p4-r0':'EARTH VEINS.','holdout-s3-p4-r2':'RAILWAY TRACKS\nTORN APART IN\nMULTIPLE LOCATIONS,\nCAUSING SOME\nCASUALTIES...',
 'holdout-s4-p4-r2':'LIFT!','holdout-s4-p4-r4':'TWITCH!',
 'holdout-s5-p4-r0':'HMPH, NOT AS\nIMPRESSIVE AS\nI THOUGHT.',
 'holdout-s5-p4-r2':"THAT'S ONLY BE-\nCAUSE YOU'RE WAY\nTOO STRONG.",
 'holdout-s5-p4-r4':"BUT IN\nTHIS SITUATION, I\nGUESS WE DON'T\nNEED IT.",
 'holdout-s6-p4-r4':'まあいいじゃん妹で鬱憤晴らしてもバチは当たらんだろ',
 'holdout-s7-p4-r0':'TO STRENGTHEN A\nBODY WEAKENED BY\nTHE FROST CURSE\nEVEN A LITTLE...',
 'holdout-s7-p4-r2':'IS IT A\nNO...?',
 'holdout-s7-p4-r4':'...HOW\nCOULD IT BE? IF\nANYTHING, I WANTED\nTO RECOMMEND IT\nTO YOU.',
 'holdout-s6-p5-r0':'あぁ～妹メイドさん最高だわ～…',
 'holdout-s6-p5-r2':'だって気になるだろ',
 'holdout-s6-p6-r0':'どうだ思い知ったか冷徹クソ女め！俺をフりやがって当然の報いだ！',
 'holdout-s6-p6-r1':'いつか絶対犯してやるからな待ってろよ！',
 'holdout-s6-p6-r2':'なんだか飽きてきたなやっぱり妹じゃスッキリしないわ'
};
async function main(){
 const root=path.resolve('test-results/engine-comparison'),reference=JSON.parse(await fs.readFile(path.join(root,'reference.json'),'utf8'));
 reference.cases=reference.cases.filter(c=>!c.id.startsWith('holdout-'));
 // Earlier page-2/page-3 cases informed preprocessing and are development data.
 for(const c of reference.cases){c.split='development';if(c.id==='s6-p3-r5')c.text='まぁそう硬くなんなよ';}
 const fresh=JSON.parse(await fs.readFile(path.join(root,'holdout-draft.json'),'utf8'));
 reference.excluded=fresh.filter(c=>!Object.hasOwn(references,c.id)).map(c=>({id:c.id,reason:c.id==='holdout-s6-p4-r0'?'Ambiguous stylized Japanese sound effect':c.id==='holdout-s6-p5-r1'?'Multiple units with partially cropped sound effect':'Incomplete crop containing partial neighboring text'}));
 reference.cases.push(...fresh.filter(c=>Object.hasOwn(references,c.id)).map(c=>({...c,text:references[c.id],verified:true,reviewMethod:'Visual transcription before additional-engine evaluation'})));
 for(const c of reference.cases)c.cropDigest=crypto.createHash('sha256').update(await fs.readFile(path.join(root,c.file))).digest('hex');
 reference.holdoutFrozenAt=new Date().toISOString();reference.holdoutPolicy='New source pages 4-6; the selection/postprocessing implementation is frozen before reading their additional-engine outputs. No parameter tuning after the holdout run.';
 await fs.writeFile(path.join(root,'reference.json'),JSON.stringify(reference,null,2));
 console.log('Frozen '+reference.cases.filter(c=>c.split==='holdout').length+' holdout crops');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
