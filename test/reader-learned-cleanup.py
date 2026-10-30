import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from reader_surface import foreign_reading_lines, text_area, protect_neighbor_ink
import cv2
from reader_learned_mask import supported_components, fill_supported_mask

class LearnedCleanupTest(unittest.TestCase):
    def recognized_line(self, box, text):
        x0,y0,x1,y1=box
        return {'text':text,'confidence':99,'bbox':dict(zip(('x0','y0','x1','y1'),box)),
                'polygon':[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]}

    def component_ownership(self, own_box, foreign_box, clipped=False):
        ink=np.zeros((60,70),np.uint8)
        if clipped:ink[20:30,0:20]=255
        else:ink[20:30,20:40]=255
        own=self.recognized_line(own_box,'OWN')
        region={'bbox':own['bbox'],'recognitionLines':[own]}
        peer={'recognitionLines':[self.recognized_line(foreign_box,'NEIGHBOR')]}
        kept,evidence=protect_neighbor_ink(ink,ink,region,[region,peer],(0,0))
        return ink,kept,evidence

    def test_fully_owned_stroke_survives_partial_foreign_zone(self):
        ink,kept,evidence=self.component_ownership((15,15,45,35),(35,15,55,35))
        self.assertTrue(np.array_equal(kept,ink))
        self.assertEqual(evidence['protectedPixels'],0)
        self.assertEqual(evidence['ambiguousPixels'],0)

    def test_fully_foreign_stroke_is_removed_without_false_ambiguity(self):
        ink,kept,evidence=self.component_ownership((35,15,55,35),(15,15,45,35))
        self.assertFalse(np.any(kept))
        self.assertEqual(evidence['protectedPixels'],int(np.count_nonzero(ink)))
        self.assertEqual(evidence['ambiguousPixels'],0)

    def test_stroke_fully_contained_by_both_readings_remains_ambiguous(self):
        ink,kept,evidence=self.component_ownership((15,15,45,35),(10,10,50,40))
        self.assertFalse(np.any(kept))
        self.assertEqual(evidence['ambiguousPixels'],int(np.count_nonzero(ink)))

    def test_stroke_spanning_both_readings_without_containment_remains_ambiguous(self):
        ink,kept,evidence=self.component_ownership((15,15,30,35),(30,15,45,35))
        self.assertFalse(np.any(kept))
        self.assertGreater(evidence['ambiguousPixels'],0)

    def test_patch_clipped_stroke_cannot_claim_full_ownership(self):
        ink,kept,evidence=self.component_ownership((0,15,25,35),(15,15,30,35),clipped=True)
        self.assertFalse(np.any(kept))
        self.assertGreater(evidence['ambiguousPixels'],0)

    def test_own_polygon_cannot_claim_ink_in_empty_rectangle_corners(self):
        ink=np.zeros((60,70),np.uint8);ink[20:30,20:40]=255
        region={'bbox':{'x0':15,'y0':15,'x1':45,'y1':35},'recognitionLines':[{'text':'OWN','bbox':{'x0':15,'y0':15,'x1':45,'y1':35},'polygon':[[15,15],[29,15],[29,35],[15,35]]}]}
        peer={'bbox':{'x0':30,'y0':15,'x1':45,'y1':35}}
        kept,evidence=protect_neighbor_ink(ink,ink,region,[region,peer],(0,0))
        self.assertFalse(np.any(kept))
        self.assertGreater(evidence['ambiguousPixels'],0)

    def test_broad_region_fallback_cannot_claim_exclusive_ownership(self):
        ink=np.zeros((60,70),np.uint8);ink[20:30,20:40]=255
        region={'text':'unpositioned reading','bbox':{'x0':0,'y0':0,'x1':70,'y1':60}}
        peer={'recognitionLines':[self.recognized_line((35,15,55,35),'NEIGHBOR')]}
        kept,evidence=protect_neighbor_ink(ink,ink,region,[region,peer],(0,0))
        self.assertFalse(np.any(kept))
        self.assertEqual(evidence['ambiguousPixels'],int(np.count_nonzero(ink)))

    def test_slanted_neighbor_uses_polygon_not_empty_rectangle_corners(self):
        ink=np.zeros((100,100),np.uint8);ink[20:30,65:75]=255
        region={'bbox':{'x0':60,'y0':15,'x1':80,'y1':35}}
        peer={'bbox':{'x0':10,'y0':10,'x1':90,'y1':90},'recognitionLines':[{'bbox':{'x0':10,'y0':10,'x1':90,'y1':90},'polygon':[[10,10],[20,10],[90,90],[80,90]]}]}
        kept,evidence=protect_neighbor_ink(ink,ink,region,[region,peer],(0,0))
        self.assertTrue(np.array_equal(kept,ink));self.assertEqual(evidence['ambiguousPixels'],0)
        ink[50:60,50:60]=255
        # Neither zone fully owns this crossing stroke.
        _,evidence=protect_neighbor_ink(ink,ink,{'bbox':{'x0':0,'y0':0,'x1':55,'y1':100}},[peer],(0,0))
        self.assertGreater(evidence['ambiguousPixels'],0)

    def test_vertical_latin_translation_fits_along_its_source_direction(self):
        source=np.full((180,70,3),255,np.uint8)
        region={'text':'A long English note','textRotation':90,'bbox':{'x0':20,'y0':15,'x1':40,'y1':165},'recognitionLines':[{'text':'A long English note','bbox':{'x0':20,'y0':15,'x1':40,'y1':165}}]}
        placement={'fillColor':'#ffffff'}
        self.assertIsNotNone(text_area(source,region,placement,[]))
        self.assertEqual(placement['rotatedTextBox']['angle'],-90)
        self.assertGreater(placement['rotatedTextBox']['width'],placement['rotatedTextBox']['height']*5)

    def test_closed_balloon_border_does_not_fill_its_interior_as_art(self):
        source=np.full((120,120,3),255,np.uint8)
        cv2.rectangle(source,(15,15),(105,105),(0,0,0),3)
        region={'bbox':{'x0':25,'y0':25,'x1':95,'y1':95}}
        placement={'fillColor':'#ffffff','surfaceValidated':True,'polygon':[[19,19],[101,19],[101,101],[19,101]]}
        safe=text_area(source,region,placement,[])
        self.assertEqual(safe,region['bbox'])
        cv2.rectangle(source,(50,30),(70,90),(0,0,0),2)
        safe=text_area(source,region,placement,[])
        self.assertTrue(safe['x1']<=47 or safe['x0']>=73)

    def test_model_and_line_support_preserve_adjacent_art(self):
        gray=np.full((60,100),255,np.uint8)
        gray[20:35,15:30]=0;gray[20:35,50:70]=0
        probability=np.zeros_like(gray,np.float32);probability[20:35,15:30]=.9
        lines=[{'text':'Hi','bbox':{'x0':10,'y0':15,'x1':75,'y1':40}}]
        mask=supported_components(gray,probability,np.full_like(gray,255),lines)
        self.assertTrue(np.all(mask[20:35,15:30]>0))
        self.assertFalse(np.any(mask[20:35,50:70]))
        source=np.repeat(gray[:,:,None],3,axis=2)
        clean,_=fill_supported_mask(source,mask)
        self.assertTrue(np.all(clean[20:35,15:30]==255))
        self.assertTrue(np.array_equal(clean[20:35,50:70],source[20:35,50:70]))

    def test_rejected_duplicate_does_not_steal_a_complete_line(self):
        host={'recognitionLines':[{'text':"It's time!!",'confidence':99,'bbox':{'x0':10,'y0':10,'x1':100,'y1':40}}]}
        fragment={'text':'imell','confidence':98,'bbox':{'x0':55,'y0':12,'x1':98,'y1':38}}
        independent={'text':'SFX','bbox':{'x0':70,'y0':0,'x1':100,'y1':8}}
        peer={'excludeFromLayoutCompetition':True,'recognitionLines':[fragment,independent]}
        self.assertEqual(foreign_reading_lines(host,peer),[independent])
        peer['excludeFromLayoutCompetition']=False
        self.assertEqual(foreign_reading_lines(host,peer),[fragment,independent])
        peer['excludeFromLayoutCompetition']=True;host['recognitionLines'][0]['confidence']=80
        self.assertEqual(foreign_reading_lines(host,peer),[fragment,independent])

if __name__=='__main__':unittest.main()
