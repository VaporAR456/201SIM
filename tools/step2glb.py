import sys, time
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.RWGltf import RWGltf_CafWriter
from OCP.OCP.collections import IndexedDataMap_TCollection_AsciiString_TCollection_AsciiString as InfoMap
from OCP.Message import Message_ProgressRange
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
src, out, defl = sys.argv[1], sys.argv[2], float(sys.argv[3])
t=time.time()
doc = TDocStd_Document(TCollection_ExtendedString("doc"))
r = STEPCAFControl_Reader(); r.SetColorMode(True); r.SetNameMode(True)
print('read', r.ReadFile(src)); print('transfer', r.Transfer(doc), time.time()-t, flush=True)
for shape in [r.ChangeReader().OneShape()]:
    pass
    BRepMesh_IncrementalMesh(shape, defl, False, float(sys.argv[4]) if len(sys.argv)>4 else 0.5, True)
print('meshed', time.time()-t, flush=True)
w = RWGltf_CafWriter(TCollection_AsciiString(out), True)
w.ChangeCoordinateSystemConverter().SetInputLengthUnit(0.001)
w.Perform(doc, InfoMap(), Message_ProgressRange())
print('written', time.time()-t)
