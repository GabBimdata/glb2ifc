# Répare un GLB généré par le plan detector pour que les murs deviennent des hôtes Door/Window dans Smelt Modeler.
# Usage: python scripts/repair-plan-detector-glb-hosts.py input.glb output.glb
import json, struct, sys, pathlib, math
import numpy as np
JSON_CHUNK=0x4E4F534A; BIN_CHUNK=0x004E4942

def pad4bytes(b, pad=b' '):
    while len(b) % 4: b += pad
    return b

def read_glb(path):
    data=pathlib.Path(path).read_bytes(); magic,version,length=struct.unpack_from('<4sII',data,0)
    if magic!=b'glTF' or version!=2: raise ValueError('Not a GLB v2')
    off=12; chunks=[]
    while off<len(data):
        clen,ctype=struct.unpack_from('<II',data,off); off+=8; chunks.append((ctype,data[off:off+clen])); off+=clen
    gltf=json.loads(chunks[0][1].decode('utf8').rstrip('\0 ')); bin_chunk=b''
    for ctype,cdata in chunks[1:]:
        if ctype==BIN_CHUNK: bin_chunk=cdata
    return gltf, bytearray(bin_chunk)

def write_glb(path,gltf,bin_chunk):
    if gltf.get('buffers'): gltf['buffers'][0]['byteLength']=len(bin_chunk)
    jb=pad4bytes(json.dumps(gltf,ensure_ascii=False,separators=(',',':')).encode('utf8'),b' ')
    bb=pad4bytes(bytes(bin_chunk),b'\0')
    chunks=[(JSON_CHUNK,jb)]
    if bb: chunks.append((BIN_CHUNK,bb))
    total=12+sum(8+len(c) for _,c in chunks)
    out=bytearray(struct.pack('<4sII',b'glTF',2,total))
    for ctype,cdata in chunks: out+=struct.pack('<II',len(cdata),ctype)+cdata
    pathlib.Path(path).write_bytes(out)

def accessor_view(gltf, acc_i, bin_chunk):
    acc=gltf['accessors'][acc_i]; bv=gltf['bufferViews'][acc['bufferView']]
    off=bv.get('byteOffset',0)+acc.get('byteOffset',0); count=acc['count']
    if acc['componentType']==5126 and acc['type']=='VEC3': return np.frombuffer(bin_chunk,dtype='<f4',count=count*3,offset=off).reshape(count,3).copy()
    if acc['componentType'] in (5123,5125) and acc['type']=='SCALAR': return np.frombuffer(bin_chunk,dtype=('<u2' if acc['componentType']==5123 else '<u4'),count=count,offset=off).astype(np.int64).copy()
    raise NotImplementedError((acc['componentType'], acc['type']))

def append_accessor_vec3(gltf, bin_chunk, arr):
    arr=np.asarray(arr,dtype='<f4')
    while len(bin_chunk)%4: bin_chunk.append(0)
    offset=len(bin_chunk); raw=arr.tobytes(); bin_chunk.extend(raw)
    bv_i=len(gltf.setdefault('bufferViews',[])); gltf['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':len(raw),'target':34962})
    acc_i=len(gltf.setdefault('accessors',[])); gltf['accessors'].append({'bufferView':bv_i,'componentType':5126,'count':int(arr.shape[0]),'type':'VEC3','min':arr.min(axis=0).astype(float).tolist(),'max':arr.max(axis=0).astype(float).tolist()})
    return acc_i

def compute_normals(pos, idx):
    normals=np.zeros_like(pos,dtype=np.float64)
    for a,b,c in idx.reshape(-1,3):
        n=np.cross(pos[b]-pos[a], pos[c]-pos[a]); ln=np.linalg.norm(n)
        if ln>1e-12: n/=ln
        normals[a]+=n; normals[b]+=n; normals[c]+=n
    ln=np.linalg.norm(normals,axis=1); ok=ln>1e-12
    normals[ok]=normals[ok]/ln[ok,None]; normals[~ok]=np.array([0,1,0])
    return normals.astype('<f4')

def baseline_to_wallpath(extras):
    b=extras.get('baseline') or extras.get('centerline') or extras.get('wallLine') or {}
    start=extras.get('start') or {'x':b.get('x1',0),'y':b.get('y1',0),'z':b.get('z1',0)}
    end=extras.get('end') or {'x':b.get('x2',0),'y':b.get('y2',0),'z':b.get('z2',0)}
    h=float(extras.get('wallHeight') or extras.get('height') or 2.5); t=float(extras.get('wallThickness') or extras.get('thickness') or 0.2); elev=float(extras.get('storeyElevation') or 0)
    return {'start':{'x':float(start.get('x',0)),'y':float(start.get('y',elev)),'z':float(start.get('z',0))},'end':{'x':float(end.get('x',0)),'y':float(end.get('y',elev)),'z':float(end.get('z',0))},'prev':None,'next':None,'height':h,'thickness':t,'alignment':extras.get('wallAlignment') or 'center','kind':extras.get('wallType') or extras.get('kind') or 'wall','baseElevation':elev,'storeyId':extras.get('storeyId') or 'storey-0','storeyName':extras.get('storeyName') or 'Storey 0','openings':list((extras.get('wallPath') or {}).get('openings') or extras.get('openings') or [])}

def promote_wall(extras,next_id):
    wp=baseline_to_wallpath(extras); s,e=wp['start'],wp['end']; length=math.dist((s['x'],s['y'],s['z']),(e['x'],e['y'],e['z']))
    h=wp['height']; t=wp['thickness']; line={'x1':s['x'],'y1':s['y'],'z1':s['z'],'x2':e['x'],'y2':e['y'],'z2':e['z']}; dims={'length':length,'height':h,'thickness':t,'alignment':wp['alignment'],'kind':wp['kind']}
    extras.update({'authoringType':'wall','ifcHint':'IfcWall','smeltIfcType':'IfcWall','ifcType':'IfcWall','IFCType':'IfcWall','smeltPredefinedType':'.STANDARD.','storeyId':wp['storeyId'],'storeyName':wp['storeyName'],'storeyElevation':wp['baseElevation'],'dimensions':dims,'wallPath':wp,'__modelerId':int(extras.get('__modelerId') or extras.get('modelerId') or next_id),'modelerId':int(extras.get('modelerId') or extras.get('__modelerId') or next_id),'type':'wall','kind':'wall','elementType':'wall','category':'wall','modelerType':'wall','modelerKind':'wall','authoringKind':'wall','authoringElementType':'wall','smeltAuthoringType':'wall','smeltObjectType':'wall','isWall':True,'isAuthoring':True,'isAuthoringWall':True,'authoringElement':True,'isAuthoringElement':True,'authoringWall':True,'openingHost':True,'hostOpenings':True,'canHostOpenings':True,'smeltOpeningHost':True,'wallHeight':h,'height':h,'wallThickness':t,'thickness':t,'wallLength':length,'length':length,'start':s,'end':e,'baseline':line,'centerline':line,'wallLine':line})
    authoring=extras.get('authoring') or {}; authoring.update({'type':'wall','kind':'wall','elementType':'wall','category':'wall','isWall':True,'isAuthoring':True,'isAuthoringWall':True,'openingHost':True,'canHostOpenings':True,'hostOpenings':True,'wallHeight':h,'height':h,'wallThickness':t,'thickness':t,'wallLength':length,'length':length,'wallPath':wp,'baseline':line,'centerline':line,'start':s,'end':e})
    extras['authoring']=authoring; extras['smeltAuthoring']=authoring; extras['wall']={**(extras.get('wall') or {}), **authoring}
    return extras

def main(inp,out):
    gltf, bin_chunk=read_glb(inp); max_id=0
    for n in gltf.get('nodes',[]):
        e=n.get('extras') or {}
        for k in ('modelerId','__modelerId'):
            try: max_id=max(max_id,int(e.get(k) or 0))
            except Exception: pass
    next_id=max_id+1; promoted=0; normals_added=0
    for n in gltf.get('nodes',[]):
        e=n.get('extras') or {}; name=n.get('name','')
        is_wall=(str(e.get('authoringType','')).lower()=='wall' or str(e.get('type','')).lower()=='wall' or name.lower().startswith('wall'))
        is_plan=(e.get('smeltDetectedFromPlan') or e.get('smeltSource')=='plan_detector')
        if is_wall and is_plan and 'wallPath' not in e:
            e=promote_wall(e,next_id); n['extras']=e; promoted+=1; next_id+=1
        if is_wall and n.get('mesh') is not None:
            m=gltf['meshes'][n['mesh']]; me=m.get('extras') or {}
            for key in ['authoringType','ifcHint','smeltIfcType','ifcType','IFCType','wallPath','dimensions','isWall','isAuthoringWall','openingHost','canHostOpenings','hostOpenings','wallHeight','wallThickness','wallLength','type','kind','category']:
                if key in n.get('extras',{}): me[key]=n['extras'][key]
            m['extras']=me; prim=m['primitives'][0]
            if 'NORMAL' not in prim.get('attributes',{}) and 'POSITION' in prim.get('attributes',{}) and 'indices' in prim:
                pos=accessor_view(gltf,prim['attributes']['POSITION'],bin_chunk); idx=accessor_view(gltf,prim['indices'],bin_chunk)
                prim['attributes']['NORMAL']=append_accessor_vec3(gltf,bin_chunk,compute_normals(pos,idx)); normals_added+=1
    write_glb(out,gltf,bin_chunk); print(f'promoted={promoted} normals_added={normals_added} output={out}')

if __name__=='__main__':
    if len(sys.argv)<3:
        print('Usage: python repair-plan-detector-glb-hosts.py input.glb output.glb', file=sys.stderr); sys.exit(2)
    main(sys.argv[1], sys.argv[2])
