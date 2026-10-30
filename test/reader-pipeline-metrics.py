import importlib.util
import unittest
import sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from reader_mask_candidates import supported_components
from reader_cleanup_candidates import fill_supported_mask

spec=importlib.util.spec_from_file_location('metrics',Path(__file__).resolve().parents[1]/'scripts/reader-pipeline-metrics.py')
metrics=importlib.util.module_from_spec(spec);spec.loader.exec_module(metrics)

class MetricsTest(unittest.TestCase):
    def setUp(self):
        self.source=np.full((40,80,3),255,np.uint8)
        self.source[10:20,10:20]=0;self.source[10:20,50:60]=0
        self.truth=np.zeros((40,80),np.uint8);self.truth[10:20,10:20]=255
        self.ignore=np.zeros_like(self.truth)

    def test_abstention_does_not_count_as_successful_cleanup(self):
        _,m=metrics.score(self.source,np.zeros_like(self.truth),self.truth,self.ignore)
        self.assertEqual(m['textCoverage'],0)
        self.assertEqual(m['darkTextPixelsRemaining'],100)
        self.assertEqual(m['protectedInkChanged'],0)

    def test_text_and_artwork_erasure_are_separate(self):
        mask=self.truth.copy();mask[9:21,49:61]=255
        _,m=metrics.score(self.source,mask,self.truth,self.ignore)
        self.assertEqual(m['textCoverage'],1)
        self.assertEqual(m['protectedInkChanged'],100)

    def test_ignored_ambiguity_is_not_counted_as_known_text(self):
        self.ignore[10:20,10:15]=255
        _,m=metrics.score(self.source,self.truth,self.truth,self.ignore)
        self.assertEqual(m['referenceTextPixels'],50)

    def test_confident_art_outside_reading_line_is_preserved(self):
        gray=self.source[:,:,0];prob=np.full(gray.shape,.8)
        lines=[{'text':'HI','bbox':{'x0':8,'y0':8,'x1':25,'y1':23}}]
        mask=supported_components(gray,prob,np.full(gray.shape,255,np.uint8),lines)
        self.assertTrue(np.all(mask[10:20,10:20]>0))
        self.assertTrue(np.all(mask[10:20,50:60]==0))

    def test_weak_terminal_dot_requires_punctuation_evidence(self):
        gray=np.full((40,90),255,np.uint8);gray[8:25,12:22]=0;gray[26:29,72:75]=0
        prob=np.zeros(gray.shape);prob[8:25,12:22]=.9;prob[26:29,72:75]=.15
        line={'text':'HI!','bbox':{'x0':8,'y0':6,'x1':80,'y1':32}}
        allowed=np.full(gray.shape,255,np.uint8)
        self.assertGreater(supported_components(gray,prob,allowed,[line])[27,73],0)
        self.assertEqual(supported_components(gray,prob,allowed,[{**line,'text':'HI'}])[27,73],0)

    def test_flat_fill_near_dark_frame_preserves_pixels_outside_mask(self):
        source=np.full((45,60,3),255,np.uint8);source[:,50:53]=0;source[12:30,44:47]=0
        mask=np.zeros(source.shape[:2],np.uint8);mask[11:31,43:48]=255
        result,info=fill_supported_mask(source,mask)
        self.assertGreater(info['flatComponents'],0)
        self.assertTrue(np.all(result[12:30,44:47]==255))
        self.assertTrue(np.array_equal(result[mask==0],source[mask==0]))

    def test_supported_glyph_keeps_strokes_outside_a_tight_ocr_rectangle(self):
        gray=np.full((60,130),255,np.uint8);gray[20:45,20:36]=0;gray[20:45,95:108]=0
        prob=np.full(gray.shape,.9)
        lines=[{'text':'TEXT','bbox':{'x0':24,'y0':18,'x1':80,'y1':48}}]
        mask=supported_components(gray,prob,np.full(gray.shape,255,np.uint8),lines)
        self.assertTrue(np.all(mask[20:45,20:36]>0),'left stroke must not be clipped to the OCR rectangle')
        self.assertTrue(np.all(mask[20:45,95:108]==0),'unread neighboring art remains protected')

if __name__=='__main__':unittest.main()
